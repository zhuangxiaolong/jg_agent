import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { JiraFlowInput, JiraTestImage } from '../../../../packages/domain/src';
import { inspectJiraImage, type JiraConnector } from '../../../../packages/jira-connector/src';
import type { LocalStore } from '../../../../packages/storage/src';

const TEST_SUMMARY_LENGTH = 50;
const VERIFICATION_TEXT = /测试|构建|验证|核验|\b(?:tests?|build|verification)\b/i;
const VERIFICATION_LIMITATION = /失败|未执行|未运行|未通过|未验证|未核验|未覆盖|受阻|无法|不能|尚未|未能|\b(?:failed|failure|blocked|unverified|not\s+(?:run|tested|executed))\b/i;

function briefTestResult(text: string, prefix: string): string {
  const sentences = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .split(/\r?\n|(?<=[。！？!?；;])/).map(line => line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)、]\s*)+/, '')
      .replace(/[`*~]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(line => line && !/^(?:测试(?:结果)?|构建|验证(?:结果)?|核验|总结|结论|test(?: results?)?|build|verification)[：:]?$/i.test(line));
  const checks = sentences.filter(line => VERIFICATION_TEXT.test(line));
  const limitation = checks.find(line => VERIFICATION_LIMITATION.test(line)) ?? sentences.find(line => VERIFICATION_LIMITATION.test(line));
  let summary = limitation ?? checks[0] ?? sentences[0] ?? '暂无测试结论，请补充实际测试情况。';
  // 长句优先保留限制所在分句，避免截掉“未执行”等关键信息。
  if (limitation && Array.from(prefix + summary).length > TEST_SUMMARY_LENGTH) summary = limitation.split(/[，,；;]/).find(part => VERIFICATION_LIMITATION.test(part))?.trim() || limitation;
  const marker = limitation && VERIFICATION_LIMITATION.exec(summary);
  if (marker && Array.from(prefix + summary.slice(0, marker.index + marker[0].length)).length >= TEST_SUMMARY_LENGTH) summary = summary.slice(marker.index);
  const characters = Array.from(prefix + summary);
  return characters.length > TEST_SUMMARY_LENGTH ? characters.slice(0, TEST_SUMMARY_LENGTH - 1).join('').trimEnd() + '…' : characters.join('');
}

export function sessionTestResult(store: LocalStore, key: string): { testResult: string; sessionId?: string } {
  const session = store.listSessions().find(item => item.jiraIssue?.key === key);
  if (!session) return { testResult: '暂无关联会话测试结果，请补充实际测试情况。' };
  const events = store.events(session.id), lastUser = events.map(item => item.type).lastIndexOf('user');
  const replies: string[] = []; let streamed = '';
  const flush = () => { if (streamed.trim()) replies.push(streamed); streamed = ''; };
  for (const event of events.slice(lastUser + 1)) {
    if (event.type === 'delta') streamed += event.text;
    else { flush(); if (event.type === 'message' && event.text.trim() && !/^### 代码变更(?:已)?核验/.test(event.text.trim())) replies.push(event.text); }
  }
  flush();
  const prefix = session.status === 'completed' ? '会话摘要（待核验）：' : session.status === 'failed' ? '会话失败，记录待核验：' : session.status === 'interrupted' ? '会话中断，记录待核验：' : '会话未完成，记录待核验：';
  return { sessionId: session.id, testResult: briefTestResult(replies.at(-1) ?? '', prefix) };
}
export const jiraFlowSchema = z.object({ key: z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9]\d*$/), projectKey: z.string().max(100).optional(), transitionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), assignee: z.object({ id: z.string().min(1).max(200), displayName: z.string().max(200), field: z.enum(['name', 'accountId']) }).strict().optional(), comment: z.string().trim().min(1).max(30000), imageIds: z.array(z.string().uuid()).max(20), sessionId: z.string().uuid().optional() }).strict();
interface ImageEntry { name: string; bytes: Uint8Array; mimeType: string; uploaded?: { scope: string; key: string; id: string; name: string } }
export class JiraTestImages {
  private images = new Map<string, ImageEntry>();
  async add(filenames: string[]): Promise<JiraTestImage[]> {
    if (filenames.length > 20) throw new Error('每次最多选择 20 张测试图片');
    const staged: [string, ImageEntry][] = []; let total = 0;
    const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    for (const filename of filenames) {
      const stat = await lstat(filename); if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('测试图片须为不超过 8 MiB 的普通文件');
      const bytes = await readFile(filename); total += bytes.length; if (total > 32 * 1024 * 1024) throw new Error('测试图片总量不能超过 32 MiB');
      const inspected = inspectJiraImage(bytes, types[path.extname(filename).toLowerCase()] ?? '');
      staged.push([randomUUID(), { name: path.basename(filename), bytes, mimeType: inspected.mimeType }]);
    }
    if ([...this.images.values()].reduce((sum, image) => sum + image.bytes.length, 0) + total > 64 * 1024 * 1024) throw new Error('待上传测试图片过多，请先提交或重启清理');
    for (const [id, value] of staged) this.images.set(id, value);
    return staged.map(([id, image]) => ({ id, name: image.name, preview: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}` }));
  }
  async submit(connector: JiraConnector, scope: string, input: JiraFlowInput): Promise<string> {
    const selected = input.imageIds.map(id => { const image = this.images.get(id); if (!image) throw new Error('测试图片已失效，请重新选择'); return image; });
    const completed: string[] = [];
    try {
      const transitions = await connector.transitions(input.key); if (!transitions.some(item => item.id === input.transitionId)) throw new Error('任务状态已变化，请刷新流转选项');
      for (const image of selected) {
        if (!image.uploaded || image.uploaded.scope !== scope || image.uploaded.key !== input.key) image.uploaded = { ...await connector.uploadTestImage(input.key, image.name, image.bytes, image.mimeType), scope, key: input.key };
        completed.push(`图片 ${image.name} 已上传`);
      }
      if (input.assignee) { await connector.assign(input.key, input.assignee); completed.push(`经办人已设为 ${input.assignee.displayName}`); }
      const comment = input.comment + (selected.length ? '\n\n测试图片：\n' + selected.map(image => `[^${image.uploaded!.name}]`).join('\n') : '');
      await connector.transition(input.key, input.transitionId, comment);
      for (const id of input.imageIds) this.images.delete(id);
      return `任务已流转至“${transitions.find(item => item.id === input.transitionId)!.status}”，测试结果与 ${selected.length} 张图片已附上。`;
    } catch (error) {
      throw new Error(`${completed.length ? completed.join('；') + '。' : ''}状态流转未确认成功：${(error as Error).message}。请刷新确认当前状态后再操作。`);
    }
  }
}
