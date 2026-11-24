import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { CodeIndexSymbol, KnowledgeChunk } from '../../domain/src';

const EXCLUDED_DIRECTORIES = new Set(['.git', '.codex', 'node_modules', 'bin', 'obj', 'dist', 'release', 'coverage', '.next', '.turbo']);
const TEXT_EXTENSIONS = new Set(['.cs', '.csproj', '.fs', '.fsproj', '.vb', '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.sql', '.xml', '.yaml', '.yml', '.vue', '.py', '.java', '.kt', '.go', '.rs', '.sln']);
const SENSITIVE_NAME = /(^|[._-])(secret|secrets|credential|credentials|password|passwd|token|apikey|api-key|private-key)([._-]|$)/i;
const SENSITIVE_CONTENT = /(?:BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|Bearer\s+[A-Za-z0-9._~+/-]{12,}|(?:api[_-]?key|password|token|secret)\s*[:=]\s*["'][^"']{8,}["'])/i;

export interface ScannedCodeFile { relativePath: string; absolutePath: string; language: string; content: string; contentHash: string; }
export interface CodeScanResult { files: ScannedCodeFile[]; symbols: CodeIndexSymbol[]; skipped: Array<{ path: string; reason: string }>; errors: Array<{ path: string; error: string }>; }

export function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isSafeIndexPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => part === '..' || part === '.git')) return false;
  const parts = normalized.split('/');
  if (parts.some(part => EXCLUDED_DIRECTORIES.has(part.toLowerCase()))) return false;
  const name = parts.at(-1) ?? '';
  if (SENSITIVE_NAME.test(name) || name.endsWith('.pem') || name.endsWith('.p12') || name.endsWith('.pfx')) return false;
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function languageFor(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (['.cs', '.csproj', '.fs', '.fsproj', '.vb', '.sln'].includes(extension)) return 'csharp';
  if (['.ts', '.tsx'].includes(extension)) return 'typescript';
  if (['.js', '.jsx', '.vue'].includes(extension)) return 'javascript';
  if (extension === '.sql') return 'sql';
  if (extension === '.py') return 'python';
  if (['.java', '.kt'].includes(extension)) return 'jvm';
  if (extension === '.go') return 'go';
  if (extension === '.rs') return 'rust';
  return 'text';
}

function lineNumber(content: string, offset: number): number { return content.slice(0, offset).split('\n').length; }

function symbolsFor(file: ScannedCodeFile, projectId: string, sourceId: string, commitHash?: string): CodeIndexSymbol[] {
  const output: CodeIndexSymbol[] = [];
  const add = (kind: CodeIndexSymbol['kind'], name: string, offset: number, signature?: string) => output.push({ id: randomUUID(), sourceId, projectId, filePath: file.relativePath, language: file.language, kind, name, line: lineNumber(file.content, offset), ...(signature ? { signature: signature.trim().slice(0, 500) } : {}), contentHash: file.contentHash, ...(commitHash ? { commitHash } : {}) });
  const patterns: Array<[CodeIndexSymbol['kind'], RegExp]> = [
    ['class', /\b(?:public\s+|internal\s+|export\s+|abstract\s+|partial\s+)*class\s+([A-Za-z_$][\w$]*)/g],
    ['interface', /\b(?:public\s+|export\s+)*interface\s+([A-Za-z_$][\w$]*)/g],
    ['struct', /\bstruct\s+([A-Za-z_$][\w$]*)/g],
    ['enum', /\benum\s+([A-Za-z_$][\w$]*)/g],
    ['function', /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g],
    ['method', /\b(?:public|private|protected|internal|static|async|override|virtual|partial|\s)+\s+([A-Za-z_$][\w$]*)\s*\([^\n;]{0,240}\)\s*(?:=>|\{|:)/g],
    ['sql-table', /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?([A-Za-z0-9_.-]+)/gi],
    ['sql-view', /\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+["`\[]?([A-Za-z0-9_.-]+)/gi],
  ];
  for (const [kind, pattern] of patterns) {
    for (const match of file.content.matchAll(pattern)) {
      const name = match[1];
      if (!name || output.some(item => item.kind === kind && item.name === name && item.line === lineNumber(file.content, match.index ?? 0))) continue;
      add(kind, name, match.index ?? 0, match[0]);
      if (output.length >= 1000) return output;
    }
  }
  return output;
}

async function collect(root: string, current: string, files: ScannedCodeFile[], skipped: CodeScanResult['skipped'], errors: CodeScanResult['errors'], budget: { count: number; bytes: number }): Promise<void> {
  if (files.length >= 3000 || budget.bytes >= 64 * 1024 * 1024) return;
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); } catch (error) { errors.push({ path: path.relative(root, current), error: error instanceof Error ? error.message : String(error) }); return; }
  for (const entry of entries) {
    if (files.length >= 3000 || budget.bytes >= 64 * 1024 * 1024) break;
    const absolute = path.join(current, entry.name);
    const relativePath = normalizeRelativePath(path.relative(root, absolute));
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase()) && !entry.name.startsWith('.')) await collect(root, absolute, files, skipped, errors, budget);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isSafeIndexPath(relativePath)) { skipped.push({ path: relativePath, reason: '文件类型、路径或文件名不在代码索引范围' }); continue; }
    try {
      const stat = await lstat(absolute);
      if (stat.size > 512 * 1024) { skipped.push({ path: relativePath, reason: '单文件超过 512 KiB' }); continue; }
      const content = (await readFile(absolute)).toString('utf8');
      budget.count += 1; budget.bytes += Buffer.byteLength(content, 'utf8');
      if (SENSITIVE_CONTENT.test(content)) { skipped.push({ path: relativePath, reason: '检测到疑似凭据内容' }); continue; }
      files.push({ relativePath, absolutePath: absolute, language: languageFor(relativePath), content, contentHash: createHash('sha256').update(content).digest('hex') });
    } catch (error) { errors.push({ path: relativePath, error: error instanceof Error ? error.message : String(error) }); }
  }
}

export async function scanCodeRepository(rootPath: string, projectId: string, sourceId: string, commitHash?: string): Promise<CodeScanResult> {
  const root = await realpath(rootPath);
  const files: ScannedCodeFile[] = [], skipped: CodeScanResult['skipped'] = [], errors: CodeScanResult['errors'] = [];
  await collect(root, root, files, skipped, errors, { count: 0, bytes: 0 });
  const symbols = files.flatMap(file => symbolsFor(file, projectId, sourceId, commitHash));
  return { files, symbols, skipped, errors };
}

export function tokenizeKnowledge(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).map(item => item.trim()).filter(item => item.length >= 2))].slice(0, 500);
}

export function chunkKnowledgeText(documentId: string, locator: string, text: string, maxCharacters = 1800): KnowledgeChunk[] {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 200 || maxCharacters > 10000) throw new Error('知识片段长度必须在 200–10000 字符之间');
  const paragraphs = text.replace(/\r/g, '').split(/\n{2,}/).map(item => item.trim()).filter(Boolean);
  const chunks: KnowledgeChunk[] = []; let current = '';
  const flush = () => { if (!current) return; const ordinal = chunks.length; chunks.push({ id: randomUUID(), documentId, ordinal, text: current, contentHash: createHash('sha256').update(current).digest('hex'), locator: `${locator}#chunk-${ordinal + 1}`, tokenTerms: tokenizeKnowledge(current) }); current = ''; };
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxCharacters) { flush(); for (let offset = 0; offset < paragraph.length; offset += maxCharacters) { current = paragraph.slice(offset, offset + maxCharacters); flush(); } continue; }
    if (current && current.length + paragraph.length + 2 > maxCharacters) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();
  return chunks;
}
