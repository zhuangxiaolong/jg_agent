import { createHash } from 'node:crypto';

export type ImpactEvidence = 'observed' | 'inferred' | 'suggested';
export type ImpactRisk = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** GitConnector.changesSince 的最小结构，保持影响分析与 Git 执行层解耦。 */
export interface ImpactDiffFile {
  path: string;
  status: string;
  diff: string;
  binary?: boolean;
  truncated?: boolean;
  unsafeReasons?: string[];
  previousPath?: string;
  layer?: string;
}

export interface ImpactDiffSet {
  baseCommit: string;
  head: string;
  baseIsAncestor?: boolean;
  changes: ImpactDiffFile[];
  truncated?: boolean;
  fingerprint: string;
}

export interface ImpactFileFact {
  path: string;
  previousPath?: string;
  status: string;
  layer?: string;
  additions: number;
  deletions: number;
  changedLineStart?: number;
  changedLineEnd?: number;
  binary: boolean;
  truncated: boolean;
  evidence: 'observed';
  source: 'git-diff';
}

export interface ImpactFinding {
  id: string;
  path: string;
  startLine?: number;
  endLine?: number;
  risk: ImpactRisk;
  evidence: ImpactEvidence;
  title: string;
  reason: string;
  suggestion: string;
  source: 'git-diff' | 'path-rule' | 'content-rule' | 'regression-rule';
  additions: number;
  deletions: number;
}

export interface ImpactAnalysisReport {
  baseCommit: string;
  head: string;
  diffFingerprint: string;
  baseIsAncestor?: boolean;
  truncated: boolean;
  files: ImpactFileFact[];
  findings: ImpactFinding[];
  recommendedCommands: Array<{ command: string; reason: string; evidence: 'suggested' }>;
  generatedAt: string;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function countLines(diff: string): { additions: number; deletions: number; start?: number; end?: number } {
  let additions = 0;
  let deletions = 0;
  let newLine = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (const line of diff.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) { newLine = Number(hunk[1]); continue; }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) continue;
    if (line.startsWith('+')) { additions++; start = start ?? newLine; end = newLine; newLine++; continue; }
    if (line.startsWith('-')) { deletions++; start = start ?? newLine; end = end ?? newLine; continue; }
    if (line.startsWith(' ')) newLine++;
  }
  return { additions, deletions, ...(start === undefined ? {} : { start, end }) };
}

function normalizePath(path: string): string { return path.replaceAll('\\', '/').toLowerCase(); }

function pathRisk(path: string): { risk: ImpactRisk; title: string; reason: string; suggestion: string } {
  const value = normalizePath(path);
  if (/(^|\/)(\.env|.*(?:secret|credential|password|token).*)$/i.test(value)) return { risk: 'critical', title: '敏感配置路径发生变更', reason: '路径规则命中凭据或敏感配置命名，工具事实不能证明内容安全。', suggestion: '人工检查变更内容，确认没有写入凭据；必要时执行凭据扫描。' };
  if (/(?:migration|migrations|schema|\.sql$|\.csproj$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$)/i.test(value)) return { risk: 'high', title: '数据结构或依赖边界发生变更', reason: '文件路径显示可能影响数据库结构、构建依赖或部署运行时。', suggestion: '执行对应数据库迁移/回滚演练，并完成完整构建与集成测试。' };
  if (/(?:controller|route|api|dto|viewmodel|repository|service|store|ipc|preload|config|appsettings)/i.test(value)) return { risk: 'medium', title: '接口或业务边界发生变更', reason: '文件路径显示可能影响接口契约、持久化或主进程边界。', suggestion: '执行相关接口、持久化、权限和兼容性回归。' };
  if (/(?:test|spec|docs?|readme|\.md$)/i.test(value)) return { risk: 'low', title: '测试或文档文件发生变更', reason: '路径规则显示该文件主要用于验证或说明，但仍需确认测试是否覆盖真实路径。', suggestion: '运行该测试文件，并核对文档示例与当前行为。' };
  return { risk: 'info', title: '代码文件发生变更', reason: '已观察到 Git Diff 文件变化，未命中特定路径风险规则。', suggestion: '根据变更符号和调用方补充针对性回归。' };
}

function contentRisk(file: ImpactDiffFile, fact: ImpactFileFact): ImpactFinding | undefined {
  if (file.unsafeReasons?.length) return { id: hash({ path: file.path, kind: 'unsafe', reasons: file.unsafeReasons }), path: file.path, risk: 'critical', evidence: 'observed', title: 'Git 变更路径被安全检查拦截', reason: file.unsafeReasons.join('；'), suggestion: '停止自动审查，人工确认路径与仓库安全状态后再继续。', source: 'git-diff', additions: fact.additions, deletions: fact.deletions };
  if (file.binary) return { id: hash({ path: file.path, kind: 'binary' }), path: file.path, risk: 'high', evidence: 'observed', title: '二进制变更无法静态读取正文', reason: 'Git 已标识二进制差异，当前报告只确认文件变化，不能推断内容影响。', suggestion: '人工查看二进制差异或生成物校验，并执行受影响功能验证。', source: 'git-diff', additions: fact.additions, deletions: fact.deletions };
  if (file.truncated) return { id: hash({ path: file.path, kind: 'truncated' }), path: file.path, startLine: fact.changedLineStart, endLine: fact.changedLineEnd, risk: 'high', evidence: 'observed', title: 'Diff 正文被截断', reason: 'Git 读取达到本次分析上限，当前报告不能覆盖完整变更正文。', suggestion: '缩小变更范围或提高读取上限后重新分析。', source: 'git-diff', additions: fact.additions, deletions: fact.deletions };
  return undefined;
}

function commandSuggestions(files: ImpactFileFact[]): Array<{ command: string; reason: string; evidence: 'suggested' }> {
  const paths = files.map(file => normalizePath(file.path));
  const commands: Array<{ command: string; reason: string; evidence: 'suggested' }> = [];
  const add = (command: string, reason: string) => { if (!commands.some(item => item.command === command)) commands.push({ command, reason, evidence: 'suggested' }); };
  if (paths.some(path => /\.(ts|tsx|js|jsx)$/.test(path))) { add('npx tsc --noEmit', 'TypeScript/JavaScript 文件发生变更，建议先做类型检查。'); add('npm test', 'TypeScript/JavaScript 文件发生变更，建议执行项目回归测试。'); }
  if (paths.some(path => /\.(cs|csproj|sln)$/.test(path))) { add('dotnet build <solution.sln>', '检测到 .NET 文件，建议完成解决方案构建。'); add('dotnet test <solution.sln>', '检测到 .NET 文件，建议执行解决方案测试。'); }
  if (paths.some(path => /(?:migration|migrations|schema|\.sql$)/i.test(path))) add('执行受影响数据库的迁移、回滚与集成测试', '检测到数据库结构或 SQL 文件，命令需由项目环境补全。');
  if (!commands.length) add('根据变更文件所属模块执行对应回归测试', '当前文件类型没有可安全推断的统一命令。');
  return commands;
}

/** 仅基于 Git 已提供的 Diff 和路径/正文规则生成静态影响报告，不进行 AI 自评。 */
export function analyzeDiffImpact(input: ImpactDiffSet, now = new Date().toISOString()): ImpactAnalysisReport {
  const files: ImpactFileFact[] = input.changes.map(file => {
    const counts = countLines(file.diff);
    return { path: file.path, ...(file.previousPath ? { previousPath: file.previousPath } : {}), status: file.status, ...(file.layer ? { layer: file.layer } : {}), additions: counts.additions, deletions: counts.deletions, ...(counts.start === undefined ? {} : { changedLineStart: counts.start, changedLineEnd: counts.end }), binary: Boolean(file.binary), truncated: Boolean(file.truncated), evidence: 'observed', source: 'git-diff' };
  });
  const findings: ImpactFinding[] = [];
  for (const [index, file] of input.changes.entries()) {
    const fact = files[index];
    const special = contentRisk(file, fact);
    if (special) findings.push(special);
    const path = pathRisk(file.path);
    findings.push({ id: hash({ path: file.path, kind: 'path-rule', risk: path.risk, additions: fact.additions, deletions: fact.deletions }), path: file.path, startLine: fact.changedLineStart, endLine: fact.changedLineEnd, risk: path.risk, evidence: 'inferred', title: path.title, reason: path.reason, suggestion: path.suggestion, source: 'path-rule', additions: fact.additions, deletions: fact.deletions });
  }
  return { baseCommit: input.baseCommit, head: input.head, ...(input.baseIsAncestor === undefined ? {} : { baseIsAncestor: input.baseIsAncestor }), diffFingerprint: input.fingerprint, truncated: Boolean(input.truncated || input.changes.some(file => file.truncated)), files, findings, recommendedCommands: commandSuggestions(files), generatedAt: now };
}
