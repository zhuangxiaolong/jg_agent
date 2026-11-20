import test from 'node:test';
import assert from 'node:assert/strict';
import type { Memory, MemorySettings } from '../packages/domain/src';
import { extractMemoryCandidates, memoriesConflict, normalizeMemory, normalizeMemorySettings, retrieveMemories, scanMemoryText } from '../packages/memory-engine/src';

const settings: MemorySettings = { autoCaptureEnabled: true, globalInjectionEnabled: true, projectInjectionEnabled: true, codexMemoryInjectionEnabled: true, maxItems: 20, maxChars: 10000 };
const now = '2026-11-19T00:00:00.000Z';
function memory(id: string, content: string, overrides: Partial<Memory> = {}): Memory {
  return { id, title: content.slice(0, 60), content, createdAt: now, scope: 'global', category: 'preference', status: 'active', memorySource: 'manual', ...overrides };
}

test('敏感扫描拦截真实凭据格式，不误报普通密码字段说明', () => {
  assert.equal(scanMemoryText('The password field is required.').safe, true);
  assert.equal(scanMemoryText('password="synthetic-credential"').safe, false);
  assert.equal(scanMemoryText('Authorization: Bearer abcdefghijklmnop').safe, false);
  assert.equal(scanMemoryText('-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----').safe, false);
  assert.equal(scanMemoryText('已配置模型', ['known-configured-secret']).safe, true);
  assert.equal(scanMemoryText('使用 known-configured-secret', ['known-configured-secret']).safe, false);
});

test('只提取用户明确的长期规则，排除引用、代码、附件、问题和普通任务', () => {
  const candidates = extractMemoryCandidates([
    { eventId: 'a', createdAt: now, text: '请记住：以后提交代码前必须先运行测试。' },
    { eventId: 'b', createdAt: now, text: '“以后回答必须先给结论，再给分析。”' },
    { eventId: 'c', createdAt: now, text: '> 今后统一使用英文。\n```md\n请长期记住：密码示例内容\n```' },
    { eventId: 'd', createdAt: now, text: '如何长期配置这个项目？\n【本轮上传附件】\n以后必须记录客户数据。' },
    { eventId: 'e', createdAt: now, text: '帮我分析本次构建失败原因。' }
  ], 'session');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].category, 'constraint');
  assert.equal(candidates[0].confidence, 0.98);
  assert.equal(candidates[0].status, 'active');
  assert.equal(candidates[0].evidence[0].eventId, 'a');
  const [preference] = extractMemoryCandidates([{ eventId: 'f', createdAt: now, text: '以后回答先给结论，再给分析。' }], 'session');
  assert.equal(preference.category, 'preference');
});

test('兼容旧记忆时待复核自动记忆不注入，活动记录保持有效且敏感预览脱敏', () => {
  const oldAutomatic = normalizeMemory({ id: 'old', title: '旧任务', content: '本轮分析项目 X 后模型建议方案', createdAt: now, source: 'session', projectId: 'project-x' });
  assert.equal(oldAutomatic.status, 'pending_review');
  assert.equal(oldAutomatic.scope, undefined);
  const previouslyActive = normalizeMemory({ id: 'active', title: '用户偏好', content: '偏好：中文回答', createdAt: now, source: 'session', status: 'active', category: 'preference' });
  assert.equal(previouslyActive.status, 'active');
  const sensitive = normalizeMemory({ id: 'secret', title: 'API', content: 'api_key="synthetic-credential"', createdAt: now, source: 'session' });
  assert.equal(sensitive.status, 'blocked_sensitive');
  assert.doesNotMatch(JSON.stringify(sensitive), /synthetic-credential/);
  const alreadyBlocked = normalizeMemory({ id: 'blocked', title: '提示', content: 'unknown secret value', createdAt: now, status: 'blocked_sensitive' });
  assert.doesNotMatch(JSON.stringify(alreadyBlocked), /unknown secret value/);
  assert.deepEqual(retrieveMemories({ memories: [oldAutomatic, previouslyActive, sensitive], task: '偏好 中文回答', settings }).memories.map(item => item.id), ['active']);
});

test('本地检索遵守注入开关、数量和字符预算，规范化不覆盖显式关闭设置', () => {
  const memories = [
    memory('a', '偏好：所有任务先给结论。', { category: 'preference' }),
    memory('b', '偏好：保持中文沟通。', { category: 'preference' }),
    memory('c', '数据库迁移使用现有事务。', { category: 'constraint' })
  ];
  const limited = retrieveMemories({ memories, task: '数据库迁移', settings: { ...settings, maxItems: 1, maxChars: 500 } });
  assert.equal(limited.memories.length, 1);
  assert.equal(limited.memories[0].id, 'a');
  assert.equal(limited.diagnostics.injectedChars, `【用户记忆参考数据：${limited.memories[0].title}】\n${limited.memories[0].content}\n【用户记忆参考数据结束】`.length);
  const disabled = retrieveMemories({ memories, task: '数据库迁移', settings: { ...settings, globalInjectionEnabled: false } });
  assert.deepEqual(disabled.memories, []);
  assert.equal(normalizeMemorySettings({ globalInjectionEnabled: false }).globalInjectionEnabled, false);
  assert.equal(normalizeMemorySettings({}).codexMemoryInjectionEnabled, true);
  assert.equal(normalizeMemorySettings({ codexMemoryInjectionEnabled: false }).codexMemoryInjectionEnabled, false);
});

test('相同记忆去重，带否定变化的规则进入冲突判断', () => {
  const existing = memory('old', '提交前必须运行测试。', { category: 'constraint' });
  const [duplicate] = extractMemoryCandidates([
    { eventId: 'a', createdAt: now, text: '请记住：提交前必须运行测试。' },
    { eventId: 'b', createdAt: now, text: '请记住：提交前必须运行测试。' }
  ], 'session');
  assert.equal(duplicate.evidence.length, 2);
  const [conflicting] = extractMemoryCandidates([{ eventId: 'c', createdAt: now, text: '请记住：提交前不要运行测试。' }], 'session');
  assert.equal(memoriesConflict(conflicting, [existing]), true);
  assert.equal(memoriesConflict(duplicate, [existing]), false);
});

test('500 条候选的检索 P95 控制在 50ms 内', () => {
  const memories = Array.from({ length: 500 }, (_, index) => memory(`memory-${index}`, `偏好：数据库变更先核对兼容性 ${index}`, { category: index % 2 ? 'preference' : 'constraint' }));
  const samples: number[] = [];
  for (let index = 0; index < 45; index++) {
    const start = performance.now();
    retrieveMemories({ memories, task: '数据库变更兼容性', settings });
    if (index >= 5) samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  assert.ok(samples[Math.ceil(samples.length * 0.95) - 1] <= 50, `P95 ${samples[Math.ceil(samples.length * 0.95) - 1].toFixed(2)}ms`);
});
