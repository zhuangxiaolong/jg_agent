import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FieldMapping, MappingSourceColumn, MappingValidationIssue } from '../../domain/src';

/** 受限 DSL：不接受脚本、SQL 或表达式。 */
export const mappingTransformSchema = z.object({
  trim: z.boolean().optional(), uppercase: z.boolean().optional(), lowercase: z.boolean().optional(),
  prefix: z.string().max(1000).optional(), suffix: z.string().max(1000).optional(),
  replaceFrom: z.string().min(1).max(1000).optional(), replaceTo: z.string().max(1000).optional(),
  constant: z.string().max(4000).optional(), defaultValue: z.string().max(4000).optional(),
  joinKeys: z.array(z.string().min(1).max(128)).max(30).optional(), separator: z.string().max(50).optional(),
  splitDelimiter: z.string().min(1).max(50).optional(), splitIndex: z.number().int().min(0).max(100).optional(),
  enumMap: z.record(z.string().max(500), z.string().max(1000)).optional(),
  multiplier: z.number().finite().optional(), decimals: z.number().int().min(0).max(12).optional(),
  type: z.enum(['text', 'number', 'integer', 'date']).optional(), required: z.boolean().optional(),
  maxLength: z.number().int().min(1).max(32000).optional(), min: z.number().finite().optional(), max: z.number().finite().optional(),
  allowedValues: z.array(z.string().max(1000)).max(1000).optional(), unique: z.boolean().optional(),
  skipReason: z.string().trim().min(1).max(1000).optional(),
}).strict();

export function applyTransform(value: unknown, transform: Record<string, unknown> = {}, row?: string[], columns?: MappingSourceColumn[]): string {
  const rule = mappingTransformSchema.parse(transform);
  let output = String(rule.constant ?? value ?? '').replace(/\u0000/g, '');
  if (rule.joinKeys?.length) output = rule.joinKeys.map(key => { const index = columns?.findIndex(item => item.key === key) ?? -1; if (index < 0) throw new Error(`拼接源列不存在：${key}`); return row?.[index] ?? ''; }).join(rule.separator ?? '');
  if (rule.skipReason) return '';
  if (rule.trim !== false) output = output.trim();
  if (!output && rule.defaultValue !== undefined) output = rule.defaultValue;
  if (rule.splitDelimiter) output = output.split(rule.splitDelimiter)[rule.splitIndex ?? 0] ?? '';
  if (rule.uppercase) output = output.toLocaleUpperCase('zh-CN');
  if (rule.lowercase) output = output.toLocaleLowerCase('zh-CN');
  if (rule.replaceFrom) output = output.split(rule.replaceFrom).join(rule.replaceTo ?? '');
  if (rule.enumMap) { if (!Object.hasOwn(rule.enumMap, output)) throw new Error(`枚举值“${output}”没有转换规则`); output = rule.enumMap[output]; }
  if (rule.multiplier !== undefined || rule.decimals !== undefined) {
    if (!output.trim() || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(output.trim())) throw new Error('不是可换算的十进制数值');
    const value = Number(output) * (rule.multiplier ?? 1);
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error('数值换算超出安全精度范围');
    output = rule.decimals === undefined ? String(value) : value.toFixed(rule.decimals);
  }
  return (rule.prefix ?? '') + output + (rule.suffix ?? '');
}

export function validateAndConvert(rows: string[][], columns: MappingSourceColumn[], mappings: FieldMapping[], runId = 'preview', options: { sourceRowNumbers?: number[]; sheetName?: string } = {}) {
  if (!mappings.length) throw new Error('没有目标字段映射，无法转换');
  const byKey = new Map(columns.map((column, index) => [column.key, index]));
  const issues: MappingValidationIssue[] = []; const output: string[][] = []; let successCount = 0;
  const parsed = mappings.map(item => mappingTransformSchema.parse(item.transformDsl));
  const seen = mappings.map(() => new Map<string, number>());
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]; const result: string[] = []; let rowError = false;
    for (const [index, mapping] of mappings.entries()) {
      const rule = parsed[index]; const sourceIndex = byKey.get(mapping.sourceColumnKey); const raw = sourceIndex === undefined ? '' : row[sourceIndex] ?? ''; let converted = '';
      const add = (message: string) => { rowError = true; issues.push({ id: randomUUID(), mappingRunId: runId, severity: 'error', ruleId: mapping.id, sheetName: options.sheetName, sourceRow: options.sourceRowNumbers?.[rowIndex] ?? rowIndex + 1, sourceColumn: mapping.sourceColumnKey, targetField: mapping.targetFieldKey, sourceValue: raw, convertedValue: converted, message, suggestion: '请核对原始值或调整映射规则后重新校验', blocking: true, status: 'open' }); if (issues.length > 10000) throw new Error('校验问题超过 10000 项，请先修正映射或拆分文件；未生成导入文件'); };
      const independent = rule.constant !== undefined || rule.defaultValue !== undefined || Boolean(rule.joinKeys?.length) || Boolean(rule.skipReason);
      if ((mapping.status === 'unmapped' || mapping.status === 'rejected' || sourceIndex === undefined) && !independent) add(`目标字段“${mapping.targetFieldLabel}”没有可用源列`);
      try { converted = applyTransform(raw, mapping.transformDsl, row, columns); } catch (error) { add(`字段“${mapping.targetFieldLabel}”转换失败：${error instanceof Error ? error.message : String(error)}`); }
      result.push(converted);
      if (rule.skipReason) continue;
      if (rule.required && !converted) add(`必填字段“${mapping.targetFieldLabel}”为空`);
      if (rule.maxLength && converted.length > rule.maxLength) add(`字段“${mapping.targetFieldLabel}”长度超过 ${rule.maxLength}`);
      if (converted && ['number', 'integer'].includes(rule.type ?? '')) {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(converted) || !Number.isFinite(Number(converted))) add(`字段“${mapping.targetFieldLabel}”不是有效数值`);
        else {
          const number = Number(converted);
          if (rule.type === 'integer' && !Number.isSafeInteger(number)) add(`字段“${mapping.targetFieldLabel}”不是安全整数`);
          if (rule.min !== undefined && number < rule.min) add(`字段“${mapping.targetFieldLabel}”小于最小值 ${rule.min}`);
          if (rule.max !== undefined && number > rule.max) add(`字段“${mapping.targetFieldLabel}”大于最大值 ${rule.max}`);
        }
      }
      if (converted && rule.type === 'date') {
        const valid = /^\d{4}-\d{2}-\d{2}$/.test(converted) && Number.isFinite(Date.parse(converted)) && new Date(converted).toISOString().slice(0, 10) === converted;
        if (!valid) add(`字段“${mapping.targetFieldLabel}”不是有效 YYYY-MM-DD 日期`);
      }
      if (converted && rule.allowedValues && !rule.allowedValues.includes(converted)) add(`字段“${mapping.targetFieldLabel}”不在允许枚举中`);
      if (converted && rule.unique) {
        const original = seen[index].get(converted);
        if (original !== undefined) add(`字段“${mapping.targetFieldLabel}”与第 ${original} 行重复`);
        else seen[index].set(converted, options.sourceRowNumbers?.[rowIndex] ?? rowIndex + 1);
      }
    }
    output.push(result); if (!rowError) successCount++;
  }
  return { output, issues, successCount, errorCount: issues.filter(issue => issue.severity === 'error').length, warningCount: issues.filter(issue => issue.severity === 'warning').length };
}
