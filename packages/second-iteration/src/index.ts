import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import type { FieldMapping, MappingRun, MappingSourceColumn, MappingSourcePreview, MappingSuggestion, MappingValidationIssue, ProjectContextSnapshot, ProjectContextSnapshotSource, ProjectDecision, ProjectFact, ProjectResourceLink, ProjectWorkspaceContext } from '../../domain/src';
export * from './governance';

export { parseCsv, parseSourceData, parseSourceBytes } from './mapping-parser';
import { parseSourceBytes } from './mapping-parser';
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function cleanCell(value: unknown): string { return String(value ?? '').replace(/\u0000/g, ''); }

export async function previewSourceFile(fileName: string, options?: { sheetName?: string; headerRow?: number; dataStartRow?: number }): Promise<MappingSourcePreview> { return parseSourceBytes(fileName, await readFile(fileName), options); }

function normalize(value: string): string { return value.toLocaleLowerCase('zh-CN').replace(/[\s_\-（）()\[\]{}:：./\\]/g, ''); }
function targetLabel(field: string): string { return field.replace(/[_-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase()); }
export function suggestMappings(columns: MappingSourceColumn[], targetFields: string[], ruleSetId = 'draft'): MappingSuggestion[] {
  return targetFields.map((field, index) => {
    const target = normalize(field); const scored = columns.map(column => { const source = normalize(column.label); const score = source === target ? 1 : source.includes(target) || target.includes(source) ? 0.82 : source.split('').filter(char => target.includes(char)).length / Math.max(source.length, target.length) * 0.7; return { column, score }; }).sort((a, b) => b.score - a.score);
    const best = scored[0]; const mapping: FieldMapping = { id: randomUUID(), ruleSetId, sourceColumnKey: best?.column.key ?? '', sourceColumnLabel: best?.column.label ?? '', targetFieldKey: field, targetFieldLabel: targetLabel(field), transformDsl: {}, confidence: Number((best?.score ?? 0).toFixed(3)), rationale: best ? `字段名相似度 ${(best.score * 100).toFixed(1)}%` : '未找到候选列', status: best && best.score >= 0.55 ? 'suggested' : 'unmapped' };
    return { mapping, score: mapping.confidence ?? 0, candidates: scored.slice(0, 3).map(item => item.column.key) };
  }).slice(0, 512);
}

/** 按真实模板列顺序补齐缺少的映射；未映射/被拒绝字段保留为阻断校验项。 */
export function alignMappingsToTemplate(columns: MappingSourceColumn[], mappings: FieldMapping[], ruleSetId: string): FieldMapping[] {
  const used = new Set<string>();
  return columns.map(column => {
    const existing = mappings.find(item => !used.has(item.id) && (item.targetFieldKey === column.key || item.targetFieldKey === column.label || item.targetFieldLabel === column.label));
    if (!existing) return { id: randomUUID(), ruleSetId, sourceColumnKey: '', sourceColumnLabel: '', targetFieldKey: column.key, targetFieldLabel: column.label, transformDsl: {}, status: 'unmapped' };
    used.add(existing.id);
    return { ...existing, ruleSetId, ...(existing.status === 'rejected' ? { sourceColumnKey: '', sourceColumnLabel: '', status: 'unmapped' as const } : {}) };
  });
}

export { applyTransform, validateAndConvert, mappingTransformSchema } from './mapping-rules';
function csvEscape(value: string): string { const safe = /^[\s\t\r]*[=+@]/.test(value) || (/^[\s\t\r]*-/.test(value) && !/^-\d+(?:\.\d+)?$/.test(value)) ? `'${value}` : value; return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; }
export function exportCsv(headers: string[], rows: string[][]): string { return [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n') + '\r\n'; }
export function exportXlsx(headers: string[], rows: string[][], sheetName = '转换结果'): Uint8Array {
  if (!sheetName || sheetName.length > 31 || /[\\/?*\[\]:\u0000-\u001f]/.test(sheetName)) throw new Error('目标工作表名称不符合 XLSX 规则');
  const escapedSheetName = sheetName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const columnName = (index: number): string => { let value = index + 1; let name = ''; while (value > 0) { const remainder = (value - 1) % 26; name = String.fromCharCode(65 + remainder) + name; value = Math.floor((value - 1) / 26); } return name; };
  const cells = (row: string[], rowNo: number) => row.map((value, index) => `<c r="${columnName(index)}${rowNo}" t="inlineStr"><is><t>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</t></is></c>`).join('');
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${[headers, ...rows].map((row, index) => `<row r="${index + 1}">${cells(row, index + 1)}</row>`).join('')}</sheetData></worksheet>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapedSheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  return zipSync({ '[Content_Types].xml': strToU8(contentTypes), '_rels/.rels': strToU8(rels), 'xl/workbook.xml': strToU8(workbook), 'xl/_rels/workbook.xml.rels': strToU8(workbookRels), 'xl/worksheets/sheet1.xml': strToU8(sheet) });
}

export function buildProjectContext(project: ProjectWorkspaceContext, resources: ProjectResourceLink[], facts: ProjectFact[], decisions: ProjectDecision[], options: { taskId?: string; budget?: number; resourceTexts?: Record<string, string> } = {}): { text: string; snapshot: ProjectContextSnapshot } {
  const budget = Math.max(0, Math.min(100000, options.budget ?? 24000));
  const selected: ProjectContextSnapshotSource[] = [];
  let text = [`【项目】${project.name}`, `项目编码：${project.projectCode ?? '未设置'}`, `客户：${project.customerName ?? '未设置'}`, `系统：${project.systemType}`, `版本：${project.productVersions.join('、') || '未设置'}`, `阶段：${project.stage}`, `状态：${project.status}`].join('\n').slice(0, budget);
  const add = (line: string, source: ProjectContextSnapshotSource) => { if (text.length + line.length + 1 > budget) return; text += '\n' + line; selected.push(source); };
  const now = new Date().toISOString();
  const supersededFacts = new Set(facts.filter(item => item.projectId === project.id && item.status === 'confirmed').map(item => item.supersedesFactId).filter(Boolean));
  for (const fact of facts.filter(item => item.projectId === project.id && item.status === 'confirmed' && !supersededFacts.has(item.id) && (!item.validFrom || item.validFrom <= now) && (!item.validTo || item.validTo >= now))) {
    const line = `事实：${fact.title}；${fact.content}`;
    add(line, { sourceType: 'fact', sourceId: fact.id, revisionId: fact.updatedAt, sha256: digest(strToU8(line)), reason: '已确认且有效的项目事实' });
  }
  const supersededDecisions = new Set(decisions.filter(item => item.projectId === project.id && item.status === 'confirmed').map(item => item.supersedesDecisionId).filter(Boolean));
  for (const decision of decisions.filter(item => item.projectId === project.id && item.status === 'confirmed' && !supersededDecisions.has(item.id))) {
    const line = `决策：${decision.title}；${decision.decision}`;
    add(line, { sourceType: 'decision', sourceId: decision.id, revisionId: decision.updatedAt, sha256: digest(strToU8(line)), reason: '已确认且未被替代的项目决策' });
  }
  for (const resource of resources.filter(item => item.projectId === project.id && item.status === 'active')) {
    const content = options.resourceTexts?.[resource.id];
    add(`资源：${resource.displayName}（${resource.resourceType}${resource.versionLabel ? `，${resource.versionLabel}` : ''}）${content ? `\n${content}` : '，仅关联元数据，未读取正文'}`, { sourceType: resource.resourceType, sourceId: resource.resourceId, revisionId: resource.versionLabel, sha256: resource.sourceSha256, reason: content ? '已读取当前项目资料片段' : '仅关联元数据，未读取正文' });
  }
  const snapshot: ProjectContextSnapshot = { id: randomUUID(), projectId: project.id, ...(options.taskId ? { taskId: options.taskId } : {}), selectedSources: selected, contextHash: digest(strToU8(text)), contextText: text, builderVersion: '0.7.1-context-2', createdAt: now };
  return { text, snapshot };
}

export function createMappingRun(input: { id?: string; jobId: string; ruleSetVersion: number; sourceSha256: string; templateSha256: string; rowCount: number; result: { successCount: number; errorCount: number; warningCount: number }; outputPath?: string }): MappingRun { const startedAt = new Date().toISOString(); return { id: input.id ?? randomUUID(), jobId: input.jobId, ruleSetVersion: input.ruleSetVersion, engineVersion: '0.7.1-mapping-1', sourceSha256: input.sourceSha256, templateSha256: input.templateSha256, rowCount: input.rowCount, successCount: input.result.successCount, errorCount: input.result.errorCount, warningCount: input.result.warningCount, ...(input.outputPath ? { outputPath: input.outputPath } : {}), status: input.result.errorCount ? 'has_errors' : 'passed', startedAt, completedAt: new Date().toISOString() };
}
