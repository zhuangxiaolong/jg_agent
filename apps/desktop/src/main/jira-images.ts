import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { JiraAttachment, JiraIssue } from '../../../../packages/domain/src';
import { assertNoPlaintextCredentials } from '../../../../packages/knowledge/src/security';
import { MAX_JIRA_IMAGE_BYTES, MAX_JIRA_IMAGES, MAX_JIRA_SESSION_IMAGE_BYTES, validateJiraImage, JiraConnector, type JiraImageMimeType } from '../../../../packages/jira-connector/src';

const extensions: Record<JiraImageMimeType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
type CachedImage = NonNullable<JiraAttachment['localImage']>;
interface CacheOptions { allowPartial?: boolean; retryFailed?: boolean }
function samePath(left: string, right: string): boolean { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; }
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function isImage(attachment: JiraAttachment): boolean { return !!attachment.localImage || /^image\//i.test(attachment.mimeType) || /\.(?:png|jpe?g|gif|webp|svg)$/i.test(attachment.name); }
function imageWarning(error: unknown): string {
  const message = error instanceof Error ? error.message.slice(0, 500) : '图片下载失败，请重试';
  try { assertNoPlaintextCredentials(message); return message; } catch { return '图片下载失败，请检查连接后重试'; }
}

/** 路径只由可信数据根与内容哈希生成，不接收 Renderer 提供的本地路径。 */
export class JiraImageStore {
  private readonly root: string;
  private readonly identities = new Map<string, string>();
  private readonly caching = new Map<string, Promise<JiraIssue>>();
  private readonly saving = new Map<string, Promise<CachedImage>>();
  private readonly connectorIds = new WeakMap<object, string>();
  constructor(dataRoot: string) { this.root = path.resolve(dataRoot, 'attachments', 'jira'); }

  private async directory(): Promise<string> {
    const parts = path.resolve(this.root).slice(path.parse(this.root).root.length).split(path.sep).filter(Boolean);
    let current = path.parse(this.root).root;
    for (const part of parts) {
      current = path.join(current, part);
      try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Jira 图片缓存目录无法创建'); }
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Jira 图片缓存目录不能是符号链接或目录联接');
      const canonical = await realpath(current);
      const identity = `${stat.dev}:${stat.ino}`;
      const previous = this.identities.get(canonical);
      if (previous && previous !== identity) throw new Error('Jira 图片缓存目录身份已变化');
      this.identities.set(canonical, identity);
    }
    return realpath(this.root);
  }

  private metadata(attachment: JiraAttachment): CachedImage {
    const value = attachment.localImage;
    if (!value || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || !Object.hasOwn(extensions, value.mimeType) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_JIRA_IMAGE_BYTES) throw new Error('Jira 图片缓存元数据无效，请重新读取任务');
    return value;
  }

  private async readImage(attachment: JiraAttachment): Promise<{ bytes: Buffer; filename: string }> {
    const image = this.metadata(attachment);
    const directory = await this.directory();
    const filename = path.join(directory, `${image.sha256}.${extensions[image.mimeType]}`);
    let stat;
    try { stat = await lstat(filename); } catch { throw new Error('Jira 图片缓存缺失，无法离线读取；请重新读取任务补齐图片'); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== image.size || !samePath(await realpath(filename), filename)) throw new Error('Jira 图片缓存文件类型、链接或大小异常');
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1 || opened.size !== image.size) throw new Error('Jira 图片缓存文件身份已变化');
      const buffer = Buffer.alloc(image.size + 1); let length = 0;
      while (length < buffer.length) { const { bytesRead } = await file.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
      const after = await file.stat();
      const linked = await lstat(filename);
      if (length !== image.size || after.size !== image.size || linked.dev !== opened.dev || linked.ino !== opened.ino || linked.nlink !== 1 || linked.isSymbolicLink() || !samePath(await realpath(filename), filename)) throw new Error('Jira 图片缓存读取期间发生变化');
      const bytes = buffer.subarray(0, length);
      if (hash(bytes) !== image.sha256 || validateJiraImage(bytes, image.mimeType) !== image.mimeType) throw new Error('Jira 图片缓存 SHA256 或图片类型校验失败');
      if (!samePath(await this.directory(), directory)) throw new Error('Jira 图片缓存目录身份已变化');
      return { bytes, filename };
    } finally { await file.close(); }
  }

  private async save(bytes: Uint8Array, mimeType: JiraImageMimeType): Promise<CachedImage> {
    validateJiraImage(bytes, mimeType);
    const image: CachedImage = { sha256: hash(bytes), mimeType, size: bytes.byteLength };
    const pending = this.saving.get(image.sha256);
    if (pending) return pending;
    const action = this.saveImage(bytes, image);
    this.saving.set(image.sha256, action);
    try { return await action; } finally { if (this.saving.get(image.sha256) === action) this.saving.delete(image.sha256); }
  }

  private async saveImage(bytes: Uint8Array, image: CachedImage): Promise<CachedImage> {
    const mimeType = image.mimeType;
    const attachment: JiraAttachment = { id: '', name: '', mimeType, size: image.size, url: '', localImage: image };
    const directory = await this.directory();
    const filename = path.join(directory, `${image.sha256}.${extensions[mimeType]}`);
    try { await lstat(filename); await this.readImage(attachment); return image; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      if (!samePath(await this.directory(), directory)) throw new Error('Jira 图片缓存目录身份已变化');
      const stat = await lstat(temporary);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== image.size) throw new Error('Jira 图片临时文件校验失败');
      await rename(temporary, filename);
      await this.readImage(attachment);
      return image;
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }

  async cacheIssue(connector: Pick<JiraConnector, 'downloadImage'>, issue: JiraIssue, options: CacheOptions = {}): Promise<JiraIssue> {
    if (!this.connectorIds.has(connector)) this.connectorIds.set(connector, randomUUID());
    const scope = connector instanceof JiraConnector ? connector.imageCacheScope : this.connectorIds.get(connector)!;
    const key = `${scope}:${!!options.allowPartial}:${options.retryFailed !== false}:${hash(Buffer.from(JSON.stringify(issue)))}`;
    const pending = this.caching.get(key);
    if (pending) return pending;
    const action = this.cacheIssueImages(connector, issue, options);
    this.caching.set(key, action);
    try { return await action; } finally { if (this.caching.get(key) === action) this.caching.delete(key); }
  }

  private async cacheIssueImages(connector: Pick<JiraConnector, 'downloadImage'>, issue: JiraIssue, options: CacheOptions): Promise<JiraIssue> {
    if (!options.allowPartial && issue.attachments.filter(isImage).length > MAX_JIRA_IMAGES) throw new Error('Jira 任务图片超过 20 张，请拆分任务');
    const attachments: JiraAttachment[] = []; let total = 0, count = 0;
    for (const attachment of issue.attachments) {
      if (!isImage(attachment)) { attachments.push({ ...attachment }); continue; }
      if (options.allowPartial && options.retryFailed === false && attachment.imageWarning && !attachment.localImage) { attachments.push({ ...attachment }); continue; }
      const { localImage: _previousImage, imageWarning: _previousWarning, ...source } = attachment;
      try {
        if (count++ >= MAX_JIRA_IMAGES) throw new Error('已达到每会话自动处理 20 张图片上限，此图片未带入');
        let image: CachedImage;
        if (attachment.localImage) { await this.readImage(attachment); image = this.metadata(attachment); }
        else { const downloaded = await connector.downloadImage(attachment); image = await this.save(downloaded.bytes, downloaded.mimeType); }
        if (total + image.size > MAX_JIRA_SESSION_IMAGE_BYTES) throw new Error('已达到会话图片总量 32 MiB 上限，此图片未带入');
        total += image.size;
        attachments.push({ ...source, localImage: { ...image } });
      } catch (error) {
        if (!options.allowPartial) throw error;
        attachments.push({ ...source, imageWarning: imageWarning(error) });
      }
    }
    return { ...issue, attachments };
  }

  async dataUrl(attachment: JiraAttachment): Promise<string> {
    const { bytes } = await this.readImage(attachment);
    return `data:${this.metadata(attachment).mimeType};base64,${bytes.toString('base64')}`;
  }

  async runtimePaths(issue: JiraIssue): Promise<string[]> {
    const images = issue.attachments.filter(item => isImage(item) && !(item.imageWarning && !item.localImage));
    if (images.length > MAX_JIRA_IMAGES) throw new Error('Jira 任务图片超过 20 张，请拆分任务');
    const filenames: string[] = []; let total = 0;
    for (const image of images) {
      const { bytes, filename } = await this.readImage(image);
      total += bytes.length;
      if (total > MAX_JIRA_SESSION_IMAGE_BYTES) throw new Error('Jira 会话图片总量超过 32 MiB，请拆分任务');
      filenames.push(filename);
    }
    return filenames;
  }
}
