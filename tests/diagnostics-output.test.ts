import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDiagnosticOutput } from '../apps/desktop/src/main/diagnostics-ipc';

test('诊断助手兼容旧版分诊字段并保留来源引用', () => {
  const normalized = normalizeDiagnosticOutput({
    summary: '发现库存同步异常',
    product: 'MES6',
    prioritySuggestion: 'P1',
    knownFacts: [{ fact: '现场反馈库存数量不一致', sourceId: 'source-1' }],
    missingInformation: ['请补充发生时间'],
    hypotheses: [{ hypothesis: '接口同步延迟', basis: '需要核对接口日志', status: 'suspected' }],
  }, 'triage') as Record<string, any>;

  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.product, 'MES6');
  assert.equal(normalized.prioritySuggestion, 'high');
  assert.deepEqual(normalized.knownFacts, [{ text: '现场反馈库存数量不一致', sourceRefs: ['source-1'] }]);
  assert.deepEqual(normalized.missingInformation, [{ question: '请补充发生时间', whyItMatters: '需要现场补充以便继续判断', priority: 'medium' }]);
  assert.deepEqual(normalized.hypotheses, [{
    title: '接口同步延迟', category: 'other', confidence: 'medium', supportingRefs: [], contradictingRefs: [], nextVerification: '请现场工程师验证：需要核对接口日志',
  }]);
  assert.equal((normalizeDiagnosticOutput({ schemaVersion: 1, summary: '待核对', product: 'MES' }, 'triage') as Record<string, unknown>).product, 'unknown');
});

test('诊断助手支持常见结果包装层', () => {
  const normalized = normalizeDiagnosticOutput({ result: { schemaVersion: 1, summary: '待核对', hypotheses: [] } }, 'root_cause') as Record<string, any>;
  assert.deepEqual(normalized, { schemaVersion: 1, summary: '待核对', hypotheses: [] });
});
