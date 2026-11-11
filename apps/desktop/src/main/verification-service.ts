import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createEvidenceManifest,
  evaluateBuildRun,
  evaluateTestRun,
  fingerprintWorkspace,
  generateMarkdownRunReport,
  parseJUnitXml,
  verifyEvidenceManifest,
  type EvidenceManifest,
  type ParsedTestReport,
  type ProcessStatus,
  type VerificationRunType,
  type VerificationStatus,
} from '../../../../packages/verification/src';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 128 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const SAFE_PROJECT_ID = /^[a-f0-9]{24}$/i;
const SAFE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface VerificationRunRequest {
  projectId: string;
  projectName: string;
  sessionId: string;
  workspacePath: string;
  evidenceRoot: string;
  runType: Extract<VerificationRunType, 'build' | 'test' | 'lint' | 'typecheck' | 'custom'>;
  executable: string;
  args: string[];
  testReportPath?: string;
  branch?: string;
  jiraIssueKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  environment?: Record<string, string>;
  redact?: (text: string) => string;
  runId?: string;
}

export interface VerificationRunRecord {
  version: 1;
  runId: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  runType: VerificationRunRequest['runType'];
  executable: string;
  args: string[];
  cwd: string;
  branch?: string;
  jiraIssueKey?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  processStarted: boolean;
  processStatus: ProcessStatus;
  exitCode: number | null;
  signal?: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  fingerprintBefore?: string;
  fingerprintAfter?: string;
  headSha?: string;
  testReport?: ParsedTestReport;
  status: VerificationStatus;
  evidenceManifestSha256: string;
  limitations: string[];
}

export interface VerificationRunResult {
  record: VerificationRunRecord;
  evidenceDirectory: string;
  manifest: EvidenceManifest;
  markdown: string;
}

export type VerificationProfileId = 'typecheck' | 'tests';

export interface VerificationRunSummary {
  record: VerificationRunRecord;
  markdown: string;
}

interface WorkspaceSnapshot {
  headSha: string;
  branch: string;
  fingerprint: string;
}

interface CapturedOutput { bytes: number; truncated: boolean; content: Buffer }

function hashBytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Application-owned profiles. Renderer input never contains an executable or arguments. */
export async function verificationProfile(profileId: VerificationProfileId, workspacePath: string): Promise<Pick<VerificationRunRequest, 'runType' | 'executable' | 'args' | 'testReportPath' | 'timeoutMs' | 'environment'>> {
  const repositoryRoot = await realpathDirectory(workspacePath);
  const node = process.execPath;
  if (profileId === 'typecheck') {
    const tsc = path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!(await lstat(tsc).then(info => info.isFile() && !info.isSymbolicLink()).catch(() => false))) throw new Error('当前工作区未安装 TypeScript，无法启动类型检查');
    return {
    runType: 'typecheck',
    executable: node,
    args: [tsc, '--noEmit', '--pretty', 'false'],
    timeoutMs: 10 * 60 * 1000,
      environment: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  if (profileId === 'tests') {
    const testDirectory = path.join(repositoryRoot, 'tests');
    const entries = await readdir(testDirectory, { withFileTypes: true }).catch(() => []);
    const testFiles = entries.filter(entry => entry.isFile() && /^[a-zA-Z0-9._-]+\.test\.ts$/i.test(entry.name)).map(entry => path.join(testDirectory, entry.name)).sort();
    if (!testFiles.length) throw new Error('当前工作区 tests/ 下没有可识别的 *.test.ts 测试文件');
    if (testFiles.length > 200) throw new Error('测试文件超过 200 个，请在项目验证配置中拆分套件');
    const tsx = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!(await lstat(tsx).then(info => info.isFile() && !info.isSymbolicLink()).catch(() => false))) throw new Error('当前工作区未安装 tsx，无法运行 TypeScript 测试');
    return {
      runType: 'test', executable: node,
      args: [tsx, '--test', '--test-reporter=junit', '--test-reporter-destination={testReport}', ...testFiles],
      testReportPath: 'test-results/junit.xml', timeoutMs: 60 * 60 * 1000,
      environment: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  throw new Error('验证配置不存在');
}

export async function listVerificationHistory(evidenceRoot: string, projectId: string, sessionId: string, limit = 20): Promise<VerificationRunSummary[]> {
  if (!SAFE_PROJECT_ID.test(projectId) || !SAFE_SESSION_ID.test(sessionId)) throw new Error('验证项目或会话标识无效');
  const folder = path.join(path.resolve(evidenceRoot), projectId, sessionId);
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const records: VerificationRunSummary[] = [];
  for (const entry of entries.filter(item => item.isDirectory()).slice(0, 100)) {
    try {
      const runDirectory = path.join(folder, entry.name);
      const directoryInfo = await lstat(runDirectory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) continue;
      const record = JSON.parse(await readFile(path.join(runDirectory, 'run.json'), 'utf8')) as VerificationRunRecord;
      const reportPath = path.join(runDirectory, 'report.md');
      const reportInfo = await lstat(reportPath);
      if (!reportInfo.isFile() || reportInfo.isSymbolicLink() || record.projectId !== projectId || record.sessionId !== sessionId || record.runId !== entry.name) continue;
      records.push({ record, markdown: await readFile(reportPath, 'utf8') });
    } catch { /* Ignore incomplete or malformed records. */ }
  }
  const count = Math.min(Math.max(1, Math.trunc(limit)), 50);
  return records.sort((left, right) => right.record.startedAt.localeCompare(left.record.startedAt)).slice(0, count);
}

/** 查看历史记录时重新计算当前工作区指纹，供桌面端标记过期证据。 */
export async function currentWorkspaceFingerprint(workspacePath: string): Promise<string> {
  return (await workspaceSnapshot(workspacePath)).fingerprint;
}

export function isVerificationRecordStale(record: VerificationRunRecord, currentFingerprint: string | undefined): boolean {
  return Boolean(currentFingerprint && record.fingerprintAfter && record.fingerprintAfter !== currentFingerprint && record.status !== 'not_run');
}

export async function readVerificationArtifact(evidenceRoot: string, projectId: string, sessionId: string, runId: string, artifact: 'stdout.log' | 'stderr.log' | 'report.md' | 'manifest.json' | 'test-results/junit.xml'): Promise<string> {
  if (!SAFE_PROJECT_ID.test(projectId) || !SAFE_SESSION_ID.test(sessionId) || !SAFE_SESSION_ID.test(runId)) throw new Error('验证记录标识无效');
  const folder = path.join(path.resolve(evidenceRoot), projectId, sessionId, runId);
  const folderInfo = await lstat(folder);
  if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) throw new Error('验证记录不可用');
  const record = JSON.parse(await readFile(path.join(folder, 'run.json'), 'utf8')) as VerificationRunRecord;
  if (record.projectId !== projectId || record.sessionId !== sessionId || record.runId !== runId) throw new Error('验证记录归属不匹配');
  const target = path.resolve(folder, artifact);
  if (!isInside(folder, target)) throw new Error('证据文件路径无效');
  await assertNoSymlinkPath(folder, target);
  const info = await lstat(target);
  if (!info.isFile() || info.size > MAX_REPORT_BYTES && artifact !== 'stdout.log' && artifact !== 'stderr.log') throw new Error('证据文件不可读取或超出限制');
  const bytes = await readFile(target);
  return bytes.subarray(Math.max(0, bytes.length - MAX_CAPTURE_BYTES)).toString('utf8');
}

function spawnCapture(command: string, args: string[], cwd: string, maxBytes = 32 * 1024 * 1024): Promise<{ code: number; output: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (size >= maxBytes) { truncated = true; return; }
      const selected = chunk.subarray(0, Math.max(0, maxBytes - size));
      chunks.push(selected); size += selected.length;
      if (selected.length !== chunk.length) truncated = true;
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length); });
    child.once('error', reject);
    child.once('close', code => code === 0 && !truncated
      ? resolve({ code: 0, output: Buffer.concat(chunks) })
      : code === 0
        ? reject(new Error('Git 命令输出超过安全上限，无法采集完整工作区指纹'))
        : reject(new Error(`Git 命令失败：${stderr.trim() || `${command} ${args[0] ?? ''} exit ${code ?? 'unknown'}`}`)));
  });
}

async function hashFile(filename: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filename);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function workspaceSnapshot(workspacePath: string): Promise<WorkspaceSnapshot> {
  const root = await realpathDirectory(workspacePath);
  const headSha = (await spawnCapture('git', ['rev-parse', '--verify', 'HEAD^{commit}'], root, 1024)).output.toString('utf8').trim();
  let branch = '(detached)';
  try {
    branch = (await spawnCapture('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], root, 1024)).output.toString('utf8').trim() || branch;
  } catch { /* detached HEAD is a valid workspace state */ }
  const diff = (await spawnCapture('git', ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'], root)).output;
  const untracked = (await spawnCapture('git', ['ls-files', '--others', '--exclude-standard', '-z', '--'], root)).output.toString('utf8').split('\0').filter(Boolean);
  const files: Array<{ path: string; sha256: string }> = [];
  let totalBytes = 0;
  for (const relative of untracked) {
    const absolute = path.resolve(root, relative);
    if (!isInside(root, absolute)) throw new Error('工作区未跟踪文件路径超出仓库');
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`工作区包含不支持的未跟踪文件：${relative}`);
    totalBytes += info.size;
    if (info.size > MAX_UNTRACKED_FILE_BYTES || totalBytes > MAX_UNTRACKED_TOTAL_BYTES) throw new Error('未跟踪文件超出指纹采集容量，不能判定验证状态');
    files.push({ path: relative.replaceAll('\\', '/'), sha256: await hashFile(absolute) });
  }
  return {
    headSha,
    branch,
    fingerprint: fingerprintWorkspace({ headSha, workingTreeDiffSha256: hashBytes(diff), submodules: (await spawnCapture('git', ['submodule', 'status', '--recursive'], root, 4 * 1024 * 1024)).output.toString('utf8'), files }),
  };
}

async function realpathDirectory(value: string): Promise<string> {
  const absolute = path.resolve(value);
  let current = absolute;
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('验证工作目录及其祖先不能包含符号链接');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const info = await lstat(absolute);
  if (!info.isDirectory()) throw new Error('验证工作目录必须是实际目录');
  return realpath(absolute);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeRelative(value: string): string {
  if (!value || path.isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error('证据文件路径必须是规范相对路径');
  return value;
}

function capture(child: ChildProcess, stream: 'stdout' | 'stderr', maximum: number): Promise<CapturedOutput> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let saved = 0;
    const readable = child[stream];
    if (!readable) return resolve({ bytes: 0, truncated: false, content: Buffer.alloc(0) });
    readable.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      const selected = chunk.subarray(0, Math.max(0, maximum - saved));
      if (selected.length) { chunks.push(selected); saved += selected.length; }
    });
    readable.once('end', () => resolve({ bytes, truncated: bytes > saved, content: Buffer.concat(chunks) }));
    readable.once('error', () => resolve({ bytes, truncated: true, content: Buffer.concat(chunks) }));
  });
}

function terminate(child: ChildProcess): void {
  if (!child.pid || child.killed) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    killer.once('error', () => child.kill());
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  const force = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 1500);
  force.unref();
}

function safeEnvironment(input?: Record<string, string>): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'ELECTRON_RUN_AS_NODE'];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key]) result[key] = process.env[key];
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof value !== 'string' || value.length > 8192) throw new Error('验证进程环境变量无效');
    if (key === 'ELECTRON_RUN_AS_NODE' && value !== '1') throw new Error('验证进程运行模式无效');
    if (/^(?:JINGGONG_MODEL_API_KEY|.*(?:PASSWORD|TOKEN|SECRET|PRIVATE_KEY))$/i.test(key)) throw new Error(`验证进程不能通过环境变量传入凭据：${key}`);
    result[key] = value;
  }
  return result;
}

function stopProcess(child: ChildProcess, timeoutMs: number, signal?: AbortSignal): Promise<{ processStarted: boolean; processStatus: ProcessStatus; exitCode: number | null; signal?: string }> {
  return new Promise(resolve => {
    let settled = false;
    let processStarted = false;
    let status: ProcessStatus = 'running';
    const finish = (result: { processStarted: boolean; processStatus: ProcessStatus; exitCode: number | null; signal?: string }) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(result);
    };
    const onAbort = () => { status = 'cancelled'; terminate(child); };
    child.once('spawn', () => { processStarted = true; });
    child.once('error', () => finish({ processStarted: false, processStatus: 'launch_failed', exitCode: null }));
    child.once('close', (code, closeSignal) => finish({ processStarted, processStatus: status === 'running' ? closeSignal ? 'crashed' : 'completed' : status, exitCode: code, ...(closeSignal ? { signal: closeSignal } : {}) }));
    const timer = setTimeout(() => { status = 'timed_out'; terminate(child); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function reportPath(evidenceDirectory: string, value: string): string {
  const relative = safeRelative(value);
  const absolute = path.resolve(evidenceDirectory, relative);
  if (!isInside(evidenceDirectory, absolute)) throw new Error('JUnit 报告路径超出本次证据目录');
  return absolute;
}

async function assertNoSymlinkPath(root: string, target: string): Promise<void> {
  if (!isInside(root, target)) throw new Error('JUnit 报告路径超出本次证据目录');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('证据路径不允许符号链接');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}

/** Runs an explicitly configured command and persists app-collected evidence. Runtime chat events are never consumed here. */
export class VerificationRunService {
  constructor(private readonly redact: (text: string) => string = value => value) {}

  async execute(request: VerificationRunRequest): Promise<VerificationRunResult> {
    if (!SAFE_PROJECT_ID.test(request.projectId) || !SAFE_SESSION_ID.test(request.sessionId)) throw new Error('验证项目或会话标识无效');
    if (!request.projectName.trim() || request.projectName.length > 200 || !request.executable.trim() || request.executable.length > 2000) throw new Error('验证命令信息无效');
    if (!Array.isArray(request.args) || request.args.length > 256 || request.args.some(value => typeof value !== 'string' || value.length > 16_000)) throw new Error('验证命令参数无效');
    const workspacePath = await realpathDirectory(request.workspacePath);
    const evidenceRoot = path.resolve(request.evidenceRoot);
    await mkdir(evidenceRoot, { recursive: true });
    const runId = request.runId ?? randomUUID();
    if (!SAFE_SESSION_ID.test(runId)) throw new Error('验证运行标识无效');
    const evidenceDirectory = path.join(evidenceRoot, request.projectId, request.sessionId, runId);
    await mkdir(evidenceDirectory, { recursive: true });
    const normalizedReportPath = request.testReportPath?.replaceAll('\\', '/');
    if (normalizedReportPath && (!normalizedReportPath.startsWith('test-results/') || !normalizedReportPath.toLowerCase().endsWith('.xml'))) throw new Error('JUnit 报告必须保存在 test-results/ 下的 XML 文件');
    const testReportFile = request.runType === 'test' && normalizedReportPath ? reportPath(evidenceDirectory, normalizedReportPath) : undefined;
    if (testReportFile) await mkdir(path.dirname(testReportFile), { recursive: true });
    if (testReportFile) await assertNoSymlinkPath(evidenceDirectory, testReportFile);

    const before = await workspaceSnapshot(workspacePath);
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const redact = (text: string) => (request.redact ?? this.redact)(text);
    const args = request.args.map(value => value.replaceAll('{evidenceDir}', evidenceDirectory).replaceAll('{testReport}', testReportFile ?? ''));
    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 30 * 60 * 1000, 1000), MAX_TIMEOUT_MS);
    const child = spawn(request.executable, args, { cwd: workspacePath, env: safeEnvironment(request.environment), windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutPromise = capture(child, 'stdout', MAX_CAPTURE_BYTES);
    const stderrPromise = capture(child, 'stderr', MAX_CAPTURE_BYTES);
    const processResult = await stopProcess(child, timeoutMs, request.signal);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const stdoutBytes = redact(stdout.content.toString('utf8'));
    const stderrBytes = redact(stderr.content.toString('utf8'));
    const stdoutFile = path.join(evidenceDirectory, 'stdout.log');
    const stderrFile = path.join(evidenceDirectory, 'stderr.log');
    await writeFile(stdoutFile, stdoutBytes, { flag: 'wx' });
    await writeFile(stderrFile, stderrBytes, { flag: 'wx' });

    let testReport: ParsedTestReport | undefined;
    let rawTestReport: Buffer | undefined;
    if (testReportFile) {
      try {
        const info = await lstat(testReportFile);
        if (info.isFile() && !info.isSymbolicLink()) {
          const bytes = await readFile(testReportFile);
          if (bytes.length <= MAX_REPORT_BYTES) {
            rawTestReport = Buffer.from(redact(bytes.toString('utf8')), 'utf8');
            await writeFile(testReportFile, rawTestReport, { flag: 'w' });
            testReport = parseJUnitXml(rawTestReport.toString('utf8'));
          }
        }
      } catch { /* Missing or unreadable machine output remains unverified. */ }
    }
    const after = await workspaceSnapshot(workspacePath).catch(() => undefined);
    const finishedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - started);
    const artifacts: Array<{ relativePath: string; bytes: Uint8Array; mimeType: string; createdAt: string }> = [
      { relativePath: 'stdout.log', bytes: Buffer.from(stdoutBytes), mimeType: 'text/plain', createdAt: finishedAt },
      { relativePath: 'stderr.log', bytes: Buffer.from(stderrBytes), mimeType: 'text/plain', createdAt: finishedAt },
    ];
    if (testReportFile && normalizedReportPath && rawTestReport) artifacts.push({ relativePath: normalizedReportPath, bytes: rawTestReport, mimeType: 'application/xml', createdAt: finishedAt });
    const manifest = createEvidenceManifest(runId, artifacts);
    const manifestFile = path.join(evidenceDirectory, 'manifest.json');
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    const evidenceIntegrityValid = await verifyEvidenceManifest(manifest, async relative => readFile(path.join(evidenceDirectory, safeRelative(relative))));
    const common = {
      runExists: true,
      processStarted: processResult.processStarted,
      processStatus: processResult.processStatus,
      exitCode: processResult.exitCode,
      evidenceIntegrityValid,
      fingerprintBefore: before.fingerprint,
      fingerprintAfter: after?.fingerprint,
    };
    const status = request.runType === 'test'
      ? evaluateTestRun({ ...common, report: testReport })
      : evaluateBuildRun(common);
    const limitations: string[] = [];
    if (request.runType === 'test' && !testReport) limitations.push('未采集到有效的 JUnit XML 报告');
    if (stdout.truncated || stderr.truncated) limitations.push('stdout/stderr 超过 4 MiB，已截断保存');
    if (!after) limitations.push('执行后工作区指纹采集失败');
    if (request.runType !== 'test') limitations.push('本次只验证构建或静态检查，不代表测试通过');
    const record: VerificationRunRecord = {
      version: 1,
      runId,
      projectId: request.projectId,
      projectName: request.projectName,
      sessionId: request.sessionId,
      runType: request.runType,
      executable: redact(request.executable),
      args: args.map(redact),
      cwd: redact(workspacePath),
      ...(request.branch ?? before.branch ? { branch: request.branch ?? before.branch } : {}),
      ...(request.jiraIssueKey ? { jiraIssueKey: request.jiraIssueKey } : {}),
      startedAt,
      finishedAt,
      durationMs,
      ...processResult,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      fingerprintBefore: before.fingerprint,
      ...(after ? { fingerprintAfter: after.fingerprint } : {}),
      headSha: before.headSha,
      ...(testReport ? { testReport } : {}),
      status,
      evidenceManifestSha256: manifest.sha256,
      limitations,
    };
    const persisted = { ...record, executable: redact(request.executable), args: args.map(redact), cwd: redact(workspacePath) };
    await writeFile(path.join(evidenceDirectory, 'run.json'), JSON.stringify(persisted, null, 2), { flag: 'wx' });
    const markdown = generateMarkdownRunReport({
      runId,
      projectName: request.projectName,
      sessionId: request.sessionId,
      jiraIssueKey: request.jiraIssueKey,
      runType: request.runType,
      status,
      command: [persisted.executable, ...persisted.args].join(' '),
      cwd: persisted.cwd,
      branch: record.branch,
      headSha: record.headSha,
      fingerprintBefore: record.fingerprintBefore,
      fingerprintAfter: record.fingerprintAfter,
      startedAt,
      finishedAt,
      durationMs,
      exitCode: processResult.exitCode,
      testReport,
      evidenceManifestSha256: manifest.sha256,
      limitations,
    });
    await writeFile(path.join(evidenceDirectory, 'report.md'), markdown, { flag: 'wx' });
    return { record, evidenceDirectory, manifest, markdown };
  }
}
