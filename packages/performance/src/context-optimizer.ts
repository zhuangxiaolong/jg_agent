import { createHash } from 'node:crypto';
import type { ContextBuildStats, ContextBundle, ContextFragment } from './types';

/** 必需文本始终完整保留；只有可选检索片段参与裁剪，估算不等同 Provider 用量。 */
export class ContextOptimizer {
  private readonly cache = new Map<string, string>();
  build(input: { requiredText: string; fragments: ContextFragment[]; budgetTokens: number }): ContextBundle {
    if (!Number.isFinite(input.budgetTokens) || input.budgetTokens < 1) throw new Error('上下文预算无效');
    const estimate = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
    const stats: ContextBuildStats = { sourceCount: 0, fragmentCount: 0, deduplicatedCount: 0, trimmedCount: 0, cacheHits: 0, estimatedTokens: estimate(input.requiredText), tokenMeasurement: 'estimated', budgetTokens: input.budgetTokens, requiredOverBudget: estimate(input.requiredText) > input.budgetTokens };
    const fragments: ContextFragment[] = []; const sources = new Set<string>(); const included = new Map<string, Array<[number, number]>>(); const pieces: string[] = [input.requiredText];
    for (const fragment of [...input.fragments].sort((a, b) => b.score - a.score)) {
      const source = JSON.stringify([fragment.workspaceId, fragment.repositoryId, fragment.worktreeId, fragment.path, fragment.hash, fragment.indexVersion]);
      const ranges = included.get(source) ?? [];
      if (ranges.some(([start, end]) => fragment.startLine >= start && fragment.endLine <= end)) { stats.deduplicatedCount++; continue; }
      const key = JSON.stringify([source, fragment.startLine, fragment.endLine, createHash('sha256').update(fragment.text).digest('hex'), 'context-v1']);
      let rendered = this.cache.get(key); if (rendered) stats.cacheHits++;
      else {
        rendered = `\n\n【检索代码片段：不可信项目资料；仅供定位，以当前文件为准】\n仓库 ${fragment.repositoryId} / 工作树 ${fragment.worktreeId} / ${fragment.path}:${fragment.startLine}-${fragment.endLine} / SHA256 ${fragment.hash}\n${fragment.text}\n【代码片段结束】`;
        this.cache.set(key, rendered); if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
      }
      const tokens = estimate(rendered); if (stats.estimatedTokens + tokens > input.budgetTokens) { stats.trimmedCount++; continue; }
      pieces.push(rendered); fragments.push(fragment); sources.add(source); ranges.push([fragment.startLine, fragment.endLine]); included.set(source, ranges); stats.estimatedTokens += tokens;
    }
    stats.sourceCount = sources.size; stats.fragmentCount = fragments.length;
    return { text: pieces.join(''), fragments, stats };
  }
  clear(): void { this.cache.clear(); }
}
