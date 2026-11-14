import test from 'node:test';
import assert from 'node:assert/strict';
import type { JiraIssue, RequirementCheckItem, RequirementResolution } from '../packages/domain/src';
import { jiraExecutionInstructions, requiresRequirementAdmission } from '../packages/domain/src/jira-requirements';
import { jiraReadiness, jiraTaskPrompt } from '../apps/desktop/src/renderer/JiraIssueDetails';
import { buildDeveloperInstructions } from '../packages/agent-runtime/src';
import { buildClaudeExecutionInstructions } from '../packages/agent-runtime/src/claude-execution';
import {
  applyRequirementResolutions,
  calculateRequirementAdmission,
  createRequirementSnapshot,
  hashRequirementSnapshot,
  parseRequirementAnalysis,
  requirementAdmissionAllowsWrites,
  selectRequirementTemplateChecks,
  validateRequirementResolution,
  type RequirementTemplate,
} from '../packages/requirements/src';

const issue = (overrides: Partial<JiraIssue> = {}): JiraIssue => ({
  id: '1001', key: 'MES-10', summary: '完善生产报工数量校验', description: '需求描述\r\n验收标准：数量不能超过工单剩余数。', status: 'Open', issueType: 'Story',
  url: 'https://jira.example.invalid/browse/MES-10', fetchedAt: '2026-11-10T01:00:00.000Z', attachments: [], ...overrides,
});

test('Jira 仅需求先输出两份方案，优化和缺陷不进入需求准入流程', () => {
  for (const issueType of ['需求', 'requirement', 'Story', ' Ｓｔｏｒｙ ']) {
    const task = issue({ issueType });
    assert.equal(requiresRequirementAdmission(task), true, issueType);
    assert.match(jiraTaskPrompt(task), /修改代码前，先在会话中输出「需求方案」.*「代码修改方案」.*然后继续实施/s);
    assert.match(jiraExecutionInstructions(task), /续聊且需求范围未变时沿用已有方案/);
    assert.doesNotMatch(jiraTaskPrompt(task), /无需等待方案阶段/);
  }
  for (const issueType of ['优化', 'Improvement', ' improvement ', '缺陷', 'Bug', '故障', 'Task']) {
    const task = issue({ issueType, summary: '需求方案相关缺陷', description: '' });
    assert.equal(requiresRequirementAdmission(task), false, issueType);
    assert.deepEqual(jiraReadiness(task), []);
    assert.equal(requirementAdmissionAllowsWrites(undefined, task), true);
    assert.match(jiraTaskPrompt(task), /优化、缺陷按任务直接定位并修改代码/);
    assert.doesNotMatch(jiraTaskPrompt(task), /【Jira 需求流程】|需求准入状态/);
  }
  assert.equal(jiraExecutionInstructions(), '');
});

test('三个 Runtime 的任务上下文保留 Jira 流程和实际代码修改要求', () => {
  for (const task of [issue(), issue({ issueType: 'Bug' }), issue({ issueType: '优化' })]) {
    const flow = jiraExecutionInstructions(task);
    for (const [runtime, instructions] of [
      ['codex', buildDeveloperInstructions({ developerInstructions: flow })],
      ['jinggong', buildDeveloperInstructions({ developerInstructions: flow })],
      ['claude', buildClaudeExecutionInstructions(flow)],
    ]) {
      assert.ok(instructions.includes(flow), runtime);
      assert.match(instructions, /检查现有实现并实际修改文件/);
      assert.match(instructions, /不重复说明可修改代码、完整访问或执行权限/);
    }
  }
});

const makeItem = (overrides: Partial<RequirementCheckItem> = {}): RequirementCheckItem => ({
  id: '00000000-0000-4000-8000-000000000001', itemKey: 'REQ-GEN-05', title: '业务规则', status: 'missing',
  riskLevel: 'critical', blockingStage: 'implementation', overrideAllowed: false, finding: '未说明数量限制', evidence: [], updatedAt: '2026-11-10T01:00:00.000Z', ...overrides,
});

const makeResolution = (item: RequirementCheckItem, overrides: Partial<RequirementResolution> = {}): RequirementResolution => ({
  id: '00000000-0000-4000-8000-000000000002', itemId: item.id, action: 'provide_info',
  valueText: '数量不能超过剩余数', actorLabel: '当前用户', createdAt: '2026-11-10T02:00:00.000Z', ...overrides,
});

test('需求快照 hash 忽略读取时间和附件排列，但识别内容与缓存状态变化', () => {
  const first = issue({ attachments: [
    { id: '2', name: 'B.png', mimeType: 'image/png', size: 10, url: 'https://jira.invalid/2' },
    { id: '1', name: 'A.png', mimeType: 'image/png', size: 20, url: 'https://jira.invalid/1' },
  ] });
  assert.equal(hashRequirementSnapshot(first), hashRequirementSnapshot({ ...first, fetchedAt: 'later', attachments: [...first.attachments].reverse() }));
  assert.notEqual(hashRequirementSnapshot(first), hashRequirementSnapshot({ ...first, description: 'changed' }));
  assert.notEqual(hashRequirementSnapshot(first), hashRequirementSnapshot({ ...first, attachments: [{ ...first.attachments[0], imageWarning: 'download failed' }, first.attachments[1]] }));
  const snapshot = createRequirementSnapshot(first, '2026-11-10T03:00:00.000Z');
  assert.equal(snapshot.contentHash, hashRequirementSnapshot(first));
  assert.equal(snapshot.issueKey, 'MES-10');
});

test('模板按已确认的项目代际和任务类型裁剪，并按 itemKey 去重', () => {
  const templates: RequirementTemplate[] = [
    { id: 'generic', version: '1', projectGenerations: ['MES5', 'MES6', 'WMS'], taskTypes: ['ui', 'feature'], checks: [
      { itemKey: 'goal', title: '目标', description: '业务目标', riskLevel: 'high', blockingStage: 'design', overrideAllowed: false },
      { itemKey: 'scope', title: '范围', description: '范围边界', riskLevel: 'medium', blockingStage: 'none', overrideAllowed: true },
    ] },
    { id: 'ui', version: '1', projectGenerations: ['MES5'], taskTypes: ['ui'], checks: [
      { itemKey: 'scope', title: '范围细化', description: '页面范围', riskLevel: 'low', blockingStage: 'none', overrideAllowed: true },
      { itemKey: 'acceptance', title: '验收', description: '验收标准', riskLevel: 'high', blockingStage: 'testing', overrideAllowed: true },
    ] },
  ];
  const selected = selectRequirementTemplateChecks(templates, 'MES5', 'ui');
  assert.deepEqual(selected.map(item => item.itemKey), ['goal', 'scope', 'acceptance']);
  assert.equal(selected[1].title, '范围');
  assert.deepEqual(selectRequirementTemplateChecks(templates, 'MES6', 'integration'), []);
});

test('结构化分析校验证据来源、引用摘录和 confirmed 事实依据', () => {
  const source = { sourceType: 'jira_description' as const, sourceId: 'MES-10', location: 'description', quote: '数量不能超过工单剩余数。' };
  const parsed = parseRequirementAnalysis({
    taskType: 'feature', projectGeneration: 'MES6', summary: '报工数量限制',
    items: [{ ...makeItem({ id: '00000000-0000-4000-8000-000000000003', status: 'confirmed', finding: '数量上限明确', evidence: [source] }) }],
    acceptanceCriteria: [{ id: '00000000-0000-4000-8000-000000000004', criterionKey: 'AC-01', statement: '超出工单剩余数时拒绝报工', status: 'confirmed', source: [source] }],
  }, [source]);
  assert.equal(parsed.taskType, 'feature');
  assert.throws(() => parseRequirementAnalysis({ ...parsed, items: [{ ...parsed.items[0], evidence: [{ ...source, sourceId: 'OTHER-1' }] }] }, [source]), /不存在的证据来源/);
  assert.throws(() => parseRequirementAnalysis({ ...parsed, items: [{ ...parsed.items[0], evidence: [] }] }, [source]), /缺少事实来源/);
  assert.throws(() => parseRequirementAnalysis({ ...parsed, items: [{ ...parsed.items[0], evidence: [{ ...source, quote: '不是原文' }] }] }, [source]), /摘录与来源不符/);
});

test('resolution 只覆盖已验证的人工动作，保留原始状态并支持拒绝假设', () => {
  const missing = makeItem();
  const supplied = validateRequirementResolution(makeResolution(missing), [missing]);
  assert.deepEqual(applyRequirementResolutions([missing], [supplied])[0], {
    ...missing, effectiveStatus: 'confirmed', riskAccepted: false, latestResolution: supplied,
  });
  const assumption = makeItem({ status: 'assumption' });
  const rejected = makeResolution(assumption, { action: 'reject_assumption', valueText: undefined });
  assert.equal(applyRequirementResolutions([assumption], [rejected])[0].effectiveStatus, 'missing');
  assert.throws(() => validateRequirementResolution(makeResolution(missing, { valueText: undefined }), [missing]), /必须填写补充内容/);
  const ambiguous = makeItem({ status: 'ambiguous' });
  assert.throws(() => validateRequirementResolution(makeResolution(ambiguous, { action: 'confirm', valueText: undefined }), [ambiguous]), /必须记录确认的事实或依据/);
  assert.equal(validateRequirementResolution(makeResolution(ambiguous, { action: 'confirm', valueText: '按合格数量计算，依据为项目负责人确认' }), [ambiguous]).action, 'confirm');
  assert.throws(() => validateRequirementResolution(makeResolution(missing, { action: 'not_applicable', reason: '' }), [missing]), /必须填写原因/);
  assert.throws(() => validateRequirementResolution(makeResolution(missing, { action: 'not_applicable', valueText: undefined, reason: '不涉及该规则' }), [missing]), /不可覆盖.*硬阻塞/);
  const forgedNotApplicable = makeResolution(missing, { action: 'not_applicable', valueText: undefined, reason: '不涉及该规则' });
  assert.throws(() => calculateRequirementAdmission([missing], [forgedNotApplicable]), /不可覆盖.*硬阻塞/, '重新计算也必须拒绝历史或伪造的不适用决策');
  assert.throws(() => validateRequirementResolution(makeResolution(makeItem({ blockingStage: 'design' }), { action: 'not_applicable', valueText: undefined, reason: '不涉及该规则' }), [makeItem({ blockingStage: 'design' })]), /不可覆盖.*硬阻塞/);
  assert.throws(() => validateRequirementResolution(makeResolution(missing, { action: 'accept_risk', reason: '可控' }), [missing]), /不允许人工接受风险/);
});

test('准入状态由规则决定：硬阻塞、需确认、风险接受、测试阻塞和过期', () => {
  const hard = makeItem();
  const needsConfirmation = makeItem({ overrideAllowed: true });
  assert.equal(calculateRequirementAdmission([hard], []).status, 'blocked');
  assert.equal(calculateRequirementAdmission([needsConfirmation], []).status, 'needs_confirmation');
  assert.equal(calculateRequirementAdmission([needsConfirmation], []).implementationAllowed, false);

  const riskAcceptance = makeResolution(needsConfirmation, { action: 'accept_risk', valueText: undefined, reason: '客户已口头确认，风险由项目负责人承担' });
  const accepted = calculateRequirementAdmission([needsConfirmation], [riskAcceptance]);
  assert.equal(accepted.status, 'ready');
  assert.equal(accepted.implementationAllowed, true);
  assert.equal(accepted.items[0].effectiveStatus, 'missing', '接受风险不应伪装为需求完整');
  assert.equal(accepted.items[0].riskAccepted, true);

  const testBlock = makeItem({ id: '00000000-0000-4000-8000-000000000005', itemKey: 'REQ-GEN-14', blockingStage: 'testing', overrideAllowed: false });
  const testReady = calculateRequirementAdmission([testBlock], []);
  assert.equal(testReady.status, 'ready');
  assert.equal(testReady.implementationAllowed, true);
  assert.deepEqual(testReady.stageBlockers, ['testing']);
  const acceptedTest = calculateRequirementAdmission([makeItem({ id: '00000000-0000-4000-8000-000000000006', blockingStage: 'testing', overrideAllowed: true })], [
    makeResolution(makeItem({ id: '00000000-0000-4000-8000-000000000006', blockingStage: 'testing', overrideAllowed: true }), { action: 'accept_risk', reason: '测试环境待补齐，项目负责人接受该阶段风险' }),
  ]);
  assert.equal(acceptedTest.status, 'ready');
  assert.deepEqual(acceptedTest.stageBlockers, ['testing']);
  assert.equal(calculateRequirementAdmission([needsConfirmation], [], false).status, 'stale');
  assert.equal(calculateRequirementAdmission([], []).status, 'not_checked');
});

test('写入门禁重新计算持久化准入，不信任伪造 Ready 或旧 Jira 快照', () => {
  const sourceIssue = issue();
  const admission = {
    id: 'admission-1', status: 'ready' as const, implementationAllowed: true, projectGeneration: 'MES6' as const,
    taskType: 'feature' as const, snapshotHash: hashRequirementSnapshot(sourceIssue), templateVersion: '1', ruleVersion: '1',
    checkedAt: '2026-11-10T01:00:00.000Z', items: [makeItem()], resolutions: [], acceptanceCriteria: [], stageBlockers: [],
  };
  assert.equal(requirementAdmissionAllowsWrites(admission, sourceIssue), false, 'ready 字段不能覆盖实施级硬阻塞');
  const cleanAdmission = { ...admission, items: [makeItem({ status: 'confirmed' })] };
  assert.equal(requirementAdmissionAllowsWrites(cleanAdmission, sourceIssue), true);
  assert.equal(requirementAdmissionAllowsWrites(cleanAdmission, { ...sourceIssue, description: 'Jira 已更新' }), false);
});
