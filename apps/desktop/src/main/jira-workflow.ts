import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { JiraFlowInput, JiraTestImage } from '../../../../packages/domain/src';
import { inspectJiraImage, type JiraConnector } from '../../../../packages/jira-connector/src';
import type { LocalStore } from '../../../../packages/storage/src';

export function sessionTestResult(store: LocalStore, key: string): { testResult: string; sessionId?: string } {
  const session = store.listSessions().find(item => item.jiraIssue?.key === key);
  if (!session) return { testResult: '暂无关联会话测试结果，请补充实际测试情况。' };
  const events = store.events(session.id), lastUser = events.map(item => item.type).lastIndexOf('user');
  const latest = events.slice(lastUser + 1), messages = latest.filter(item => item.type === 'message' || item.type === 'delta').map(item => item.text).join('\n');
  const commands = latest.filter(item => item.type === 'tool' && /退出码|测试|test|build|构建/i.test(item.text)).map(item => item.text).join('\n');
  const outcome = session.status === 'completed' ? '会话已完成，以下内容为会话记录，请核对实际测试情况。' : '会话尚未完成，以下记录不能视为测试通过。';
  return { sessionId: session.id, testResult: `【会话测试记录】\n${outcome}\n${messages ? '\n会话结果：\n' + messages.slice(-16000) : '\n尚无会话结果。'}${commands ? '\n\n命令与验证记录：\n' + commands.slice(-6000) : '\n尚无命令验证记录。'}` };
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
