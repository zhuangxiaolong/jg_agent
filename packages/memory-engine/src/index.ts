import { createHash } from 'node:crypto';
import type { Memory, MemoryCategory, MemoryDiagnostics, MemoryEvidence, MemorySettings, MemoryStatus } from '../../domain/src';

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  autoCaptureEnabled: true,
  globalInjectionEnabled: true,
  projectInjectionEnabled: true,
  maxItems: 20,
  maxChars: 10000
};

const sensitivePatterns: Array<[string, RegExp]> = [
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi],
  ['api_key', /\b(?:sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g],
  ['credential_assignment', /\b(?:password|passwd|pwd|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*(?:"[^"\r\n]{3,}"|'[^'\r\n]{3,}'|[A-Za-z0-9_./+~-]{6,})/gi],
  ['connection_string', /\b(?:Server|Data Source|Host)\s*=\s*[^;\r\n]+(?:;\s*(?:User\s*ID|UID|Username|Password|Pwd)\s*=\s*[^;\r\n]*)+/gi],
  ['credential_uri', /\b(?:mongodb(?:\+srv)?|jdbc|redis):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi],
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi],
  ['cookie_header', /(?:^|\n)\s*(?:cookie|set-cookie|authorization)\s*:\s*[^\r\n]+/gi]
];

export interface MemorySecurityResult { safe: boolean; reasons: string[]; redactedPreview: string }

export function scanMemoryText(value: string, knownSecrets: string[] = []): MemorySecurityResult {
  const reasons = new Set<string>();
  let redactedPreview = value;
  for (const [reason, pattern] of sensitivePatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      reasons.add(reason);
      pattern.lastIndex = 0;
      redactedPreview = redactedPreview.replace(pattern, '[已脱敏]');
    }
  }
  for (const secret of knownSecrets) {
    if (secret && value.includes(secret)) {
      reasons.add('configured_credential');
      redactedPreview = redactedPreview.split(secret).join('[已脱敏]');
    }
  }
  return { safe: reasons.size === 0, reasons: [...reasons], redactedPreview };
}

export function normalizeMemory(memory: Memory, knownSecrets: string[] = []): Memory {
  const legacyAutomatic = memory.source === 'session' || memory.memorySource === 'legacy_session';
  const scan = scanMemoryText(`${memory.title}\n${memory.content}`, knownSecrets);
  const status: MemoryStatus = !scan.safe ? 'blocked_sensitive' : memory.status ?? (legacyAutomatic ? 'pending_review' : 'active');
  const category = memory.category ?? legacyCategory(memory.content);
  const memorySource = memory.memorySource ?? (legacyAutomatic ? 'legacy_session' : 'manual');
  const scope = memory.scope ?? (legacyAutomatic && memory.projectId ? undefined : 'global');
  if (!scan.safe || memory.status === 'blocked_sensitive') return { ...memory, title: '已拦截的敏感记忆', content: '[敏感内容已拦截，内容隐藏]', category, memorySource, status: 'blocked_sensitive', ...(scope ? { scope } : {}), reviewReason: scan.reasons.join(',') || memory.reviewReason };
  return { ...memory, category, memorySource, status, ...(scope ? { scope } : {}) };
}

export function normalizeMemorySettings(value: Partial<MemorySettings> | undefined): MemorySettings {
  return {
    autoCaptureEnabled: typeof value?.autoCaptureEnabled === 'boolean' ? value.autoCaptureEnabled : DEFAULT_MEMORY_SETTINGS.autoCaptureEnabled,
    globalInjectionEnabled: typeof value?.globalInjectionEnabled === 'boolean' ? value.globalInjectionEnabled : DEFAULT_MEMORY_SETTINGS.globalInjectionEnabled,
    projectInjectionEnabled: typeof value?.projectInjectionEnabled === 'boolean' ? value.projectInjectionEnabled : DEFAULT_MEMORY_SETTINGS.projectInjectionEnabled,
    maxItems: typeof value?.maxItems === 'number' && Number.isInteger(value.maxItems) && value.maxItems >= 1 && value.maxItems <= 20 ? value.maxItems : DEFAULT_MEMORY_SETTINGS.maxItems,
    maxChars: typeof value?.maxChars === 'number' && Number.isInteger(value.maxChars) && value.maxChars >= 500 && value.maxChars <= 10000 ? value.maxChars : DEFAULT_MEMORY_SETTINGS.maxChars
  };
}

export interface MemoryInputMessage { text: string; eventId: string; createdAt: string }
export interface MemoryCandidate { title: string; content: string; category: MemoryCategory; confidence: number; tags: string[]; evidence: MemoryEvidence[]; status: 'active' | 'pending_review' }

export function validateMemoryFields(memory: Pick<Memory, 'title' | 'content' | 'tags' | 'evidence'>): void {
  if (!memory.title.trim() || memory.title.length > 120) throw new Error('记忆标题长度必须为 1–120 个字符');
  if (!memory.content.trim() || memory.content.length > 12000) throw new Error('记忆内容长度必须为 1–12,000 个字符');
  if ((memory.tags?.length ?? 0) > 20 || memory.tags?.some(tag => tag.length > 40)) throw new Error('记忆标签最多 20 个，每个不超过 40 个字符');
  if ((memory.evidence?.length ?? 0) > 10) throw new Error('记忆来源证据最多 10 条');
}

export function extractMemoryCandidates(messages: MemoryInputMessage[], sessionId: string, knownSecrets: string[] = []): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  for (const message of messages) {
    const sanitized = message.text
      .split(/\r?\n?【本轮上传附件】/, 1)[0]
      .replace(/```[\s\S]*?(?:```|$)/g, '')
      .replace(/~~~[\s\S]*?(?:~~~|$)/g, '');
    for (const line of sanitized.split(/\r?\n/)) {
      if (/^\s*(?:>|["'“”「」『』])/.test(line)) continue;
      for (const sentence of line.split(/(?<=[。！？!?])\s*/)) {
        const text = sentence.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)、]\s*)+/, '').replace(/\*\*|__/g, '').trim().normalize('NFKC').replace(/\s+/g, ' ');
        if (text.length < 6 || text.length > 360 || /[?？]$/.test(text)) continue;
        if (/(?:是否|能否|要不要|是不是|建议|或许|可能|如果|假如|例如|比如|示例|假设|待确认|待验证|未验证)/.test(text)) continue;
        if (/(?:本次|这次|今天|明天|昨天|刚才|稍后|暂时|当前轮|这一轮|这轮|本轮)/.test(text)) continue;
        if (/(?:不要|不用|无需|不必|别|禁止)(?:自动)?(?:记住|记忆|保存为记忆|记录为记忆)/.test(text)) continue;
        const explicit = /^(?:请)?(?:记住|长期记住)[:：，,\s]/.test(text);
        const durable = /(?:以后|今后|后续|始终|一直|每次|一律|统一|默认|长期|固定|团队约定|项目约定|开发约定|发布约定)/.test(text);
        if (/^(?:请)?(?:帮我|帮我们|检查|查看|分析|查询|解释|说明|修改|修复|实现|新增|添加|删除|调整|优化|生成|整理|测试|验证|运行|执行|搜索|审阅|设计|展示|对比|总结|为什么|如何|怎么)/.test(text) && !durable && !explicit) continue;
        const cleanContent = text.replace(/^(?:请)?(?:记住|长期记住)[:：，,\s]+/, '').trim();
        if (!cleanContent || !scanMemoryText(cleanContent, knownSecrets).safe) continue;
        const preference = /(?:我|我们)(?:的|更|比较|通常|一般)?(?:喜欢|偏好|习惯|倾向)/.test(cleanContent) || (durable && /(?:回答|回复)/.test(cleanContent) && /(?:先|优先|简洁|详细|中文|英文|结论|格式|语气)/.test(cleanContent));
        const tool = /(?:Runtime|模型|工具|Codex|Claude|Grok|精工 Agent)/i.test(cleanContent) && /(?:使用|采用|切换|默认|偏好|优先)/.test(cleanContent);
        const role = /(?:我负责|我的职责|我的工作是|我的岗位是|我长期从事)/.test(cleanContent);
        const decision = /(?:已(?:经)?(?:决定|确认|确定)|最终(?:决定|确认|确定)|确认(?:采用|使用|选择|保留|取消)|决定(?:采用|使用|选择|保留|取消))/.test(cleanContent);
        const experience = /^(?:经验|教训|已验证的经验|确认的经验)[:：]/.test(cleanContent) && /(?:因为|导致|所以|避免|优先|应当|不要|不能|必须)/.test(cleanContent);
        const specificRule = /(?:必须|禁止|不得|不要|不能|需要|只能|先|优先|保持|保留|采用|使用|执行|回复|回答|输出)/.test(cleanContent);
        if (!explicit && !preference && !role && !decision && !experience && !(durable && specificRule)) continue;
        const category: MemoryCategory = tool ? 'tool_preference' : preference ? 'preference' : role ? 'role_context' : experience ? 'reusable_experience' : decision ? 'working_style' : /(?:流程|协作|步骤|方法|习惯)/.test(cleanContent) ? 'working_style' : 'constraint';
        const confidence = explicit ? 0.98 : durable ? 0.92 : preference || role ? 0.85 : 0.82;
        const evidence: MemoryEvidence = { sourceType: 'session_event', sourceId: message.eventId, sessionId, eventId: message.eventId, createdAt: message.createdAt };
        const normalized = cleanContent.replace(/[。！!]+$/, '').toLocaleLowerCase();
        const existing = candidates.find(candidate => candidate.content.replace(/[。！!]+$/, '').toLocaleLowerCase() === normalized);
        if (existing) {
          if (existing.evidence.length < 10) existing.evidence.push(evidence);
          continue;
        }
        candidates.push({ title: cleanContent.slice(0, 60), content: cleanContent, category, confidence, tags: tagsFor(category, cleanContent), evidence: [evidence], status: 'active' });
      }
    }
  }
  return candidates;
}

export function retrieveMemories(input: {
  memories: Memory[]; task: string; settings?: MemorySettings; knownSecrets?: string[]; limit?: number;
}): { memories: Memory[]; diagnostics: MemoryDiagnostics } {
  const started = performance.now();
  const settings = normalizeMemorySettings(input.settings);
  const knownSecrets = input.knownSecrets ?? [];
  const normalized = input.memories.map(memory => normalizeMemory(memory, knownSecrets));
  const eligible = settings.globalInjectionEnabled ? normalized.filter(memory => memory.status === 'active' && memory.scope === 'global' && scanMemoryText(`${memory.title}\n${memory.content}`, knownSecrets).safe) : [];
  const queryTokens = textTokens(input.task);
  const scored = eligible.map(memory => {
    const memoryTokens = textTokens(`${memory.title} ${memory.content} ${(memory.tags ?? []).join(' ')}`);
    const matches = [...queryTokens].filter(token => memoryTokens.has(token)).length;
    const baseline = ['preference', 'working_style'].includes(memory.category ?? 'other');
    return { memory, matches, score: queryTokens.size ? matches / queryTokens.size : 0, baseline };
  }).filter(item => item.baseline || item.matches >= 2 || (item.matches === 1 && item.score >= 0.25))
    .sort((left, right) => Number(right.baseline) - Number(left.baseline) || right.score - left.score || (right.memory.updatedAt ?? right.memory.createdAt).localeCompare(left.memory.updatedAt ?? left.memory.createdAt));
  const categoryBudgets: Record<MemoryCategory, number> = { preference: 2000, working_style: 2000, constraint: 2000, tool_preference: 2000, role_context: 2000, reusable_experience: 1000, other: 2000 };
  const categoryUsage = new Map<MemoryCategory, number>();
  const selected: Memory[] = [];
  let chars = 0;
  for (const item of scored) {
    const category = item.memory.category ?? 'other';
    const size = `【用户记忆参考数据：${item.memory.title}】\n${item.memory.content}\n【用户记忆参考数据结束】`.length;
    if (selected.length >= Math.min(settings.maxItems, input.limit ?? 20) || chars + size > settings.maxChars || (categoryUsage.get(category) ?? 0) + size > categoryBudgets[category]) continue;
    selected.push(item.memory); chars += size; categoryUsage.set(category, (categoryUsage.get(category) ?? 0) + size);
  }
  const retrievedAt = new Date().toISOString();
  const contextHash = createHash('sha256').update(JSON.stringify(selected.map(memory => [memory.id, memory.updatedAt ?? memory.createdAt, memory.title, memory.content]))).digest('hex');
  const diagnostics: MemoryDiagnostics = {
    retrievedAt, durationMs: Math.max(0, performance.now() - started), totalCandidates: input.memories.length,
    injectedCount: selected.length, injectedChars: chars, skippedCount: Math.max(0, eligible.length - selected.length), contextHash,
    categories: [...new Set(selected.map(memory => memory.category ?? 'other'))]
  };
  return { memories: selected, diagnostics };
}

export function memoriesConflict(candidate: MemoryCandidate, existing: Memory[]): boolean {
  const words = textTokens(candidate.content);
  return existing.some(memory => {
    const normalized = normalizeMemory(memory);
    if (normalized.status !== 'active' || normalized.category !== candidate.category) return false;
    const oldContent = normalized.content.toLocaleLowerCase();
    if (oldContent.replace(/[。！!]+$/, '') === candidate.content.toLocaleLowerCase().replace(/[。！!]+$/, '')) return false;
    const otherWords = textTokens(oldContent);
    const overlap = [...words].filter(word => otherWords.has(word)).length;
    const negationChanged = /(?:不|不得|禁止|不能|不要)/.test(oldContent) !== /(?:不|不得|禁止|不能|不要)/.test(candidate.content);
    return negationChanged && overlap >= 2;
  });
}

function legacyCategory(content: string): MemoryCategory {
  if (content.includes('偏好：')) return 'preference';
  if (content.includes('约束：')) return 'constraint';
  if (content.includes('决策：')) return 'working_style';
  if (content.includes('经验：')) return 'reusable_experience';
  return 'other';
}

function tagsFor(category: MemoryCategory, content: string): string[] {
  const tags = new Set<string>([category]);
  if (/(?:中文|英文|回复|回答|沟通|汇报)/.test(content)) tags.add('沟通');
  if (/(?:测试|构建|提交|发布|开发)/.test(content)) tags.add('开发流程');
  return [...tags].slice(0, 20);
}

function textTokens(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLocaleLowerCase();
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9_./-]{2,}|[\u3400-\u9fff]{2,}/g)) {
    const part = match[0];
    if (/^[\u3400-\u9fff]+$/.test(part)) {
      for (let index = 0; index < part.length - 1; index++) {
        const token = part.slice(index, index + 2);
        if (!/^(?:用户|自己|要求|以后|后续|当前|这个|进行|需要|可以|不要|不能)$/.test(token)) tokens.add(token);
      }
    } else tokens.add(part);
  }
  return tokens;
}
