import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { ContextOptimizer, ContextRetrievalPlanner, defaultPerformanceSettings, estimateContextTokens, type ContextCandidate } from '../packages/performance/src';

interface Case { id: string; systemType: string; taskType: string; query: string; required: string; candidates: ContextCandidate[] }
const fixtureBytes = readFileSync('tests/fixtures/context-benchmark.json');
const cases = JSON.parse(fixtureBytes.toString('utf8')) as Case[];
const settings = defaultPerformanceSettings();
const results = cases.map(item => {
  const baselineStarted = performance.now();
  const baselineText = item.required + item.candidates.map(candidate => `\n\n【${candidate.sourceType} ${candidate.title}】\n${candidate.text}`).join('');
  const baselineMs = performance.now() - baselineStarted;
  const optimizer = new ContextOptimizer();
  const planner = new ContextRetrievalPlanner();
  const request = { sessionId: 'offline-benchmark', projectId: item.candidates.find(candidate => candidate.projectId)?.projectId, workspaceId: 'fixture-workspace', systemType: item.systemType, query: item.query };
  const coldStarted = performance.now();
  const planned = planner.plan(request, item.candidates, settings);
  const cold = optimizer.build({ requiredText: item.required, candidates: planned.candidates, excluded: planned.excluded, budgetTokens: settings.contextBudgetTokens });
  const coldMs = performance.now() - coldStarted;
  const hotStarted = performance.now();
  const hotPlan = planner.plan(request, item.candidates, settings);
  const hot = optimizer.build({ requiredText: item.required, candidates: hotPlan.candidates, excluded: hotPlan.excluded, budgetTokens: settings.contextBudgetTokens });
  const hotMs = performance.now() - hotStarted;
  return {
    caseId: item.id, systemType: item.systemType, taskType: item.taskType,
    promptFingerprint: createHash('sha256').update(item.query).digest('hex'),
    baseline: { prepareMs: Number(baselineMs.toFixed(3)), candidateCount: item.candidates.length, estimatedTokens: estimateContextTokens(baselineText) },
    unifiedCold: { prepareMs: Number(coldMs.toFixed(3)), selectedCount: cold.stats.sourceCount, estimatedTokens: cold.stats.estimatedTokens, excludedCount: cold.stats.excluded?.length ?? 0 },
    unifiedHot: { prepareMs: Number(hotMs.toFixed(3)), selectedCount: hot.stats.sourceCount, estimatedTokens: hot.stats.estimatedTokens, renderCacheHits: hot.stats.cacheHits },
    runtime: 'offline-not-run', provider: 'unknown', model: 'unknown', firstTokenMs: null, totalDurationMs: null, toolEvents: null, buildTestEvidence: 'not-run',
  };
});
let repositoryCommit = 'unknown';
try { repositoryCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { repositoryCommit = 'unavailable'; }
process.stdout.write(`${JSON.stringify({ harness: 'context-engine-offline-v1', generatedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, release: os.release(), repositoryCommit, fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'), settings: { contextBudgetTokens: settings.contextBudgetTokens, unifiedContextEnabled: settings.unifiedContextEnabled } }, results, limitation: '仅测本地脱敏 fixture 的上下文准备；未启动 Runtime/Provider/模型，不代表端到端性能或模型质量。' }, null, 2)}\n`);
