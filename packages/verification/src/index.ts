import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const EVIDENCE_MANIFEST_VERSION = 1;
export const WORKSPACE_FINGERPRINT_VERSION = 1;
export const JUNIT_PARSER_VERSION = '2';

export type VerificationStatus = 'passed' | 'failed' | 'not_run' | 'indeterminate' | 'stale';
export type VerificationRunType = 'build' | 'test' | 'lint' | 'typecheck' | 'custom';
export type ProcessStatus = 'not_started' | 'running' | 'completed' | 'cancelled' | 'timed_out' | 'crashed' | 'launch_failed';

export interface TestCaseResult {
  name: string;
  suite?: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  message?: string;
  detail?: string;
}

export interface ParsedTestReport {
  parserId: 'junit-xml';
  parserVersion: string;
  status: 'parsed' | 'empty' | 'invalid';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  tests: TestCaseResult[];
  reportSha256: string;
  error?: string;
}

const junitParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
  allowBooleanAttributes: false,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function childText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value && typeof value === 'object' && '#text' in value && typeof (value as { '#text'?: unknown })['#text'] === 'string') {
    return ((value as { '#text': string })['#text']).trim() || undefined;
  }
  return undefined;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalidJUnit(source: string, error: string): ParsedTestReport {
  return { parserId: 'junit-xml', parserVersion: JUNIT_PARSER_VERSION, status: 'invalid', total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, tests: [], reportSha256: sha256(source), error };
}

/** Deterministic parser for JUnit XML. It trusts testcase nodes, not LLM or console summaries. */
export function parseJUnitXml(source: string): ParsedTestReport {
  const reportSha256 = sha256(source);
  if (!source.trim()) return { parserId: 'junit-xml', parserVersion: JUNIT_PARSER_VERSION, status: 'empty', total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, tests: [], reportSha256, error: 'JUnit 报告为空' };
  const validation = XMLValidator.validate(source);
  if (validation !== true) return invalidJUnit(source, `JUnit XML 格式错误（第 ${validation.err.line} 行）`);
  try {
    const parsed = junitParser.parse(source) as Record<string, unknown>;
    const suitesRoot = parsed.testsuites && typeof parsed.testsuites === 'object' ? parsed.testsuites as Record<string, unknown> : undefined;
    const directSuite = parsed.testsuite && typeof parsed.testsuite === 'object' ? asArray(parsed.testsuite as Record<string, unknown> | Record<string, unknown>[]) : [];
    // Node 原生 reporter 会把顶层 test() 直接写入 testsuites，仍以真实 testcase 节点计数。
    const suites = suitesRoot ? [suitesRoot] : directSuite;
    if (!suites.length || suitesRoot && directSuite.length) return invalidJUnit(source, 'JUnit 报告缺少有效的 testsuite 或 testsuites 根节点');

    const tests: TestCaseResult[] = [];
    const seenSuiteObjects = new Set<Record<string, unknown>>();
    let conflictingOutcomeMarkers = false;
    const visitSuite = (suite: Record<string, unknown>, parentName?: string): void => {
      if (seenSuiteObjects.has(suite)) return;
      seenSuiteObjects.add(suite);
      const suiteName = childText(suite['@_name']) ?? parentName;
      for (const testcase of asArray(suite.testcase as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
        const failures = asArray(testcase.failure as Record<string, unknown> | Record<string, unknown>[] | undefined);
        const errors = asArray(testcase.error as Record<string, unknown> | Record<string, unknown>[] | undefined);
        const skippedItems = asArray(testcase.skipped as Record<string, unknown> | Record<string, unknown>[] | undefined);
        const failure = failures[0]; const error = errors[0]; const skipped = skippedItems[0];
        if ([failures, errors, skippedItems].filter(items => items.length > 0).length > 1) conflictingOutcomeMarkers = true;
        const outcome = failures.length ? 'failed' : errors.length ? 'error' : skippedItems.length ? 'skipped' : 'passed';
        const issue = failure ?? error ?? skipped;
        tests.push({
          name: childText(testcase['@_name']) ?? '(未命名测试)',
          ...(childText(testcase['@_classname']) ?? suiteName ? { suite: childText(testcase['@_classname']) ?? suiteName } : {}),
          status: outcome,
          ...(issue && childText(issue['@_message']) ? { message: childText(issue['@_message']) } : {}),
          ...(issue && childText(issue['#text']) ? { detail: childText(issue['#text']) } : {}),
        });
      }
      for (const nested of asArray(suite.testsuite as Record<string, unknown> | Record<string, unknown>[] | undefined)) visitSuite(nested, suiteName);
    };
    for (const suite of suites) visitSuite(suite);
    if (conflictingOutcomeMarkers) return invalidJUnit(source, 'JUnit testcase 同时包含多个互斥结果标记');
    const failed = tests.filter(item => item.status === 'failed').length;
    const errors = tests.filter(item => item.status === 'error').length;
    const skipped = tests.filter(item => item.status === 'skipped').length;
    const total = tests.length;
    // If suite/root counters are present, require them to agree with parsed testcase rows.
    for (const suite of seenSuiteObjects) {
      const expected = parseCounter(suite['@_tests']);
      if (expected === null) return invalidJUnit(source, 'JUnit testsuite.tests 不是有效的非负整数');
      if (expected !== undefined) {
        const suiteTestCount = countSuiteCases(suite);
        if (expected !== suiteTestCount) return invalidJUnit(source, 'JUnit testsuite.tests 与 testcase 数量不一致');
      }
      const counters = countSuiteCasesByStatus(suite);
      for (const [attribute, actual] of [['failures', counters.failed], ['errors', counters.errors], ['skipped', counters.skipped]] as const) {
        const expectedStatus = parseCounter(suite[`@_${attribute}`]);
        if (expectedStatus === null) return invalidJUnit(source, `JUnit testsuite.${attribute} 不是有效的非负整数`);
        if (expectedStatus !== undefined && expectedStatus !== actual) return invalidJUnit(source, `JUnit testsuite.${attribute} 与 testcase 状态不一致`);
      }
    }
    if (suitesRoot) {
      const rootCounters = suites.reduce<TestCounters>((sum, suite) => addCounters(sum, countSuiteCasesByStatus(suite)), { total: 0, failed: 0, errors: 0, skipped: 0 });
      for (const [attribute, actual] of [['tests', rootCounters.total], ['failures', rootCounters.failed], ['errors', rootCounters.errors], ['skipped', rootCounters.skipped]] as const) {
        const expected = parseCounter(suitesRoot[`@_${attribute}`]);
        if (expected === null) return invalidJUnit(source, `JUnit testsuites.${attribute} 不是有效的非负整数`);
        if (expected !== undefined && expected !== actual) return invalidJUnit(source, `JUnit testsuites.${attribute} 与 testcase 状态不一致`);
      }
    }
    return { parserId: 'junit-xml', parserVersion: JUNIT_PARSER_VERSION, status: 'parsed', total, passed: total - failed - errors - skipped, failed, skipped, errors, tests, reportSha256, ...(total === 0 ? { error: 'JUnit 报告没有 testcase，不能证明测试通过' } : {}) };
  } catch {
    return invalidJUnit(source, 'JUnit XML 无法解析');
  }
}

function parseCounter(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function countSuiteCases(suite: Record<string, unknown>): number {
  return asArray(suite.testcase as Record<string, unknown> | Record<string, unknown>[] | undefined).length
    + asArray(suite.testsuite as Record<string, unknown> | Record<string, unknown>[] | undefined).reduce((sum, nested) => sum + countSuiteCases(nested), 0);
}

interface TestCounters {
  total: number;
  failed: number;
  errors: number;
  skipped: number;
}

function countSuiteCasesByStatus(suite: Record<string, unknown>): TestCounters {
  const cases = asArray(suite.testcase as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const own = cases.reduce<TestCounters>((result, testcase) => {
    const failure = asArray(testcase.failure as Record<string, unknown> | Record<string, unknown>[] | undefined).length > 0;
    const error = asArray(testcase.error as Record<string, unknown> | Record<string, unknown>[] | undefined).length > 0;
    const skipped = asArray(testcase.skipped as Record<string, unknown> | Record<string, unknown>[] | undefined).length > 0;
    return { total: result.total + 1, failed: result.failed + (failure ? 1 : 0), errors: result.errors + (error ? 1 : 0), skipped: result.skipped + (skipped ? 1 : 0) };
  }, { total: 0, failed: 0, errors: 0, skipped: 0 });
  return asArray(suite.testsuite as Record<string, unknown> | Record<string, unknown>[] | undefined)
    .map(countSuiteCasesByStatus).reduce<TestCounters>(addCounters, own);
}

function addCounters(left: TestCounters, right: TestCounters): TestCounters {
  return { total: left.total + right.total, failed: left.failed + right.failed, errors: left.errors + right.errors, skipped: left.skipped + right.skipped };
}

export interface TestRunEvaluation {
  runExists: boolean;
  processStarted: boolean;
  processStatus: ProcessStatus;
  exitCode: number | null;
  report?: ParsedTestReport;
  evidenceIntegrityValid: boolean;
  fingerprintBefore?: string;
  fingerprintAfter?: string;
  fingerprintCurrent?: string;
  allowZeroTests?: boolean;
  zeroTestsReason?: string;
}

export interface BuildRunEvaluation {
  runExists: boolean;
  processStarted: boolean;
  processStatus: ProcessStatus;
  exitCode: number | null;
  evidenceIntegrityValid: boolean;
  fingerprintBefore?: string;
  fingerprintAfter?: string;
  fingerprintCurrent?: string;
}

function terminalProcess(status: ProcessStatus): boolean {
  return status === 'completed';
}

function reportCountsMatch(report: ParsedTestReport): boolean {
  const counts = report.tests.reduce((result, item) => {
    result[item.status] += 1;
    return result;
  }, { passed: 0, failed: 0, error: 0, skipped: 0 });
  return report.total === report.tests.length
    && report.passed === counts.passed
    && report.failed === counts.failed
    && report.errors === counts.error
    && report.skipped === counts.skipped;
}

export function evaluateTestRun(input: TestRunEvaluation): VerificationStatus {
  if (!input.runExists) return 'not_run';
  if (!input.processStarted || !terminalProcess(input.processStatus) || input.exitCode === null) return 'indeterminate';
  if (input.exitCode !== 0) return 'failed';
  if (!input.report || input.report.status === 'invalid') return 'indeterminate';
  if (input.report.status !== 'parsed') return 'indeterminate';
  if (!reportCountsMatch(input.report)) return 'indeterminate';
  const permittedZeroTests = input.report.total === 0 && input.allowZeroTests && !!input.zeroTestsReason?.trim();
  if (input.report.failed > 0 || input.report.errors > 0) return 'failed';
  if (input.report.total === 0 && !permittedZeroTests) return 'indeterminate';
  if (!input.evidenceIntegrityValid || !input.fingerprintBefore || !input.fingerprintAfter) return 'indeterminate';
  if (input.fingerprintBefore !== input.fingerprintAfter) return 'indeterminate';
  if (input.fingerprintCurrent && input.fingerprintCurrent !== input.fingerprintAfter) return 'stale';
  return 'passed';
}

export function evaluateBuildRun(input: BuildRunEvaluation): VerificationStatus {
  if (!input.runExists) return 'not_run';
  if (!input.processStarted || !terminalProcess(input.processStatus) || input.exitCode === null) return 'indeterminate';
  if (input.exitCode !== 0) return 'failed';
  if (!input.evidenceIntegrityValid || !input.fingerprintBefore || !input.fingerprintAfter) return 'indeterminate';
  if (input.fingerprintBefore !== input.fingerprintAfter) return 'indeterminate';
  if (input.fingerprintCurrent && input.fingerprintCurrent !== input.fingerprintAfter) return 'stale';
  return 'passed';
}

/** Hashes a stable, caller-collected snapshot. File entries should exclude only explicit/versioned generated-path rules. */
export function fingerprintWorkspace(snapshot: {
  headSha?: string;
  indexDiffSha256?: string;
  workingTreeDiffSha256?: string;
  submodules?: string;
  files: Array<{ path: string; sha256: string }>;
}): string {
  const files = [...snapshot.files]
    .map(file => ({ path: normalizeRelativePath(file.path), sha256: normalizeSha256(file.sha256) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (files.some((file, index) => index > 0 && file.path === files[index - 1].path)) throw new Error('工作区指纹包含重复文件路径');
  return sha256(JSON.stringify({
    algorithmVersion: WORKSPACE_FINGERPRINT_VERSION,
    headSha: snapshot.headSha ?? '',
    indexDiffSha256: snapshot.indexDiffSha256 ?? '',
    workingTreeDiffSha256: snapshot.workingTreeDiffSha256 ?? '',
    submodules: snapshot.submodules ?? '',
    files,
  }));
}

export interface EvidenceArtifactInput {
  relativePath: string;
  bytes: Uint8Array;
  mimeType: string;
  createdAt: string;
}

export interface EvidenceArtifact {
  relativePath: string;
  size: number;
  mimeType: string;
  sha256: string;
  createdAt: string;
}

export interface EvidenceManifest {
  version: number;
  runId: string;
  fingerprintAlgorithmVersion: number;
  files: EvidenceArtifact[];
  sha256: string;
}

export function createEvidenceManifest(runId: string, artifacts: EvidenceArtifactInput[]): EvidenceManifest {
  if (!runId.trim()) throw new Error('Run ID 不能为空');
  const files = artifacts.map(item => ({
    relativePath: normalizeRelativePath(item.relativePath),
    size: item.bytes.byteLength,
    mimeType: item.mimeType,
    sha256: sha256(item.bytes),
    createdAt: item.createdAt,
  })).sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  if (files.some((item, index) => index > 0 && item.relativePath === files[index - 1].relativePath)) throw new Error('证据清单包含重复路径');
  const unsigned = { version: EVIDENCE_MANIFEST_VERSION, runId, fingerprintAlgorithmVersion: WORKSPACE_FINGERPRINT_VERSION, files };
  return { ...unsigned, sha256: sha256(JSON.stringify(unsigned)) };
}

export async function verifyEvidenceManifest(manifest: EvidenceManifest, readFile: (relativePath: string) => Promise<Uint8Array>): Promise<boolean> {
  try {
    if (manifest.version !== EVIDENCE_MANIFEST_VERSION || !manifest.runId.trim() || !Array.isArray(manifest.files)) return false;
    const paths = new Set<string>();
    for (const item of manifest.files) {
      const relative = normalizeRelativePath(item.relativePath);
      if (paths.has(relative) || relative !== item.relativePath || !Number.isSafeInteger(item.size) || item.size < 0) return false;
      paths.add(relative);
      normalizeSha256(item.sha256);
      const bytes = await readFile(relative);
      if (bytes.byteLength !== item.size || sha256(bytes) !== item.sha256) return false;
    }
    const unsigned = { version: manifest.version, runId: manifest.runId, fingerprintAlgorithmVersion: manifest.fingerprintAlgorithmVersion, files: manifest.files };
    return sha256(JSON.stringify(unsigned)) === manifest.sha256;
  } catch { return false; }
}

export interface MarkdownRunReport {
  runId: string;
  projectName: string;
  sessionId?: string;
  jiraIssueKey?: string;
  runType: VerificationRunType;
  status: VerificationStatus;
  command: string;
  cwd: string;
  branch?: string;
  headSha?: string;
  fingerprintBefore?: string;
  fingerprintAfter?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode: number | null;
  testReport?: ParsedTestReport;
  evidenceManifestSha256: string;
  limitations?: string[];
}

function md(value: string): string { return value.replace(/[|\r\n]/g, ' ').replace(/`/g, '\\`'); }

export function generateMarkdownRunReport(run: MarkdownRunReport): string {
  const statusLabel: Record<VerificationStatus, string> = { passed: '通过', failed: '失败', not_run: '未执行', indeterminate: '无法判定', stale: '已过期' };
  const test = run.runType === 'test' && run.testReport
    ? `\n\n## 测试统计\n\n| 总数 | 通过 | 失败 | 错误 | 跳过 |\n|---:|---:|---:|---:|---:|\n| ${run.testReport.total} | ${run.testReport.passed} | ${run.testReport.failed} | ${run.testReport.errors} | ${run.testReport.skipped} |\n\n解析器：${run.testReport.parserId} v${run.testReport.parserVersion}；报告 SHA-256：\`${run.testReport.reportSha256}\``
    : '';
  const failures = run.testReport?.tests.filter(item => item.status === 'failed' || item.status === 'error') ?? [];
  const failureDetails = failures.length ? `\n\n## 失败详情\n\n${failures.map(item => `- **${md(item.name)}** (${item.status})${item.message ? `：${md(item.message)}` : ''}${item.detail ? `\n  \n  ${md(item.detail)}` : ''}`).join('\n')}` : '';
  const limitations = run.limitations?.length ? `\n\n## 未覆盖项与限制\n\n${run.limitations.map(item => `- ${md(item)}`).join('\n')}` : '';
  return `# 验证运行报告\n\n- Run：\`${md(run.runId)}\`\n- 项目：${md(run.projectName)}\n${run.sessionId ? `- 会话：\`${md(run.sessionId)}\`\n` : ''}${run.jiraIssueKey ? `- Jira：\`${md(run.jiraIssueKey)}\`\n` : ''}- 类型：${run.runType}\n- 结论：${statusLabel[run.status]}\n- 分支：${md(run.branch ?? '未记录')}\n- HEAD：\`${md(run.headSha ?? '未记录')}\`\n- 指纹（执行前/后）：\`${md(run.fingerprintBefore ?? '未记录')}\` / \`${md(run.fingerprintAfter ?? '未记录')}\`\n- 命令：\`${md(run.command)}\`\n- 工作目录：\`${md(run.cwd)}\`\n- 开始/结束：${md(run.startedAt)} / ${md(run.finishedAt ?? '未完成')}\n- 耗时：${run.durationMs ?? '未记录'} ms\n- Exit Code：${run.exitCode === null ? '未记录' : run.exitCode}\n- Manifest SHA-256：\`${md(run.evidenceManifestSha256)}\`\n${test}${failureDetails}${limitations}\n\n> 本地证据可校验、可追溯；该结果不代表测试覆盖充分、业务正确或客户验收。\n`;
}

function normalizeRelativePath(value: string): string {
  if (!value || value.includes('\\') || value.includes(':') || value.startsWith('/') || value.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error('证据路径必须是规范的相对路径');
  return value;
}

function normalizeSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('SHA-256 格式无效');
  return value.toLowerCase();
}
