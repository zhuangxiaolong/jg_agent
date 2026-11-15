import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import type { DeliveryPackageRecord } from '../../domain/src';
import type { DeliverySnapshot } from '../../domain/src/delivery';

export interface DeliveryAttachment { name: string; bytes: Uint8Array; kind: 'report' | 'log' | 'screenshot' | 'customer_source' | 'repository_code' }
export interface DeliveryBuildOptions { revision: number; includeAttachments?: boolean; includeCustomerSource?: boolean }
export interface DeliveryManifest { schemaVersion: 1; taskId: string; revision: number; generatedAt: string; sourceSnapshotSha256: string; files: Array<{ name: string; size: number; sha256: string }>; excluded: Array<{ name: string; reason: string }> }
export function deliveryHash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function nextDeliveryRevision(records: DeliveryPackageRecord[], taskId: string): number { return Math.max(0, ...records.filter(item => item.taskId === taskId).map(item => item.revision)) + 1; }

function text(value: unknown): string { return typeof value === 'string' && value.trim() ? value : '未知 / 无可用证据'; }
function line(value: string): string { return value.replace(/[\r\n]+/g, ' '); }
function list(values: string[]): string { return values.length ? values.map(value => `- ${value}`).join('\n') : '- 未提供 / 未执行'; }
function verificationMarkdown(snapshot: DeliverySnapshot): string {
  const runs = snapshot.verificationRuns.map(run => `Run ${run.runId} · ${run.runType} · 状态 ${run.status} · 进程 ${run.processStatus} · 退出码 ${run.exitCode ?? '未知'}${run.testReport?.status === 'parsed' ? ` · 总数 ${run.testReport.total} / 通过 ${run.testReport.passed} / 失败 ${run.testReport.failed} / 跳过 ${run.testReport.skipped} / 错误 ${run.testReport.errors}` : ' · 测试计数未知'} · SHA ${run.headSha ?? '未知'}${run.limitations.length ? ` · 限制 ${run.limitations.join('；')}` : ''}`);
  const taskEvidence = snapshot.evidence.map(item => `历史证据 ${item.id} · ${item.evidenceType} · 来源 ${item.source} · 入库时状态 ${item.status} · 入库时完整性${item.integrityVerified ? '已校验' : '未校验'} · 当前适用性未复核，不代表当前代码通过 · 退出码 ${item.exitCode ?? '未知'} · SHA ${item.commitSha ?? '未知'}${item.testCount !== undefined ? ` · 历史测试数 ${item.testCount}` : ''}`);
  return `# 验证汇总\n\nRun 状态来自平台本次复核结果；任务关联证据只陈列历史入库状态。未记录的构建、测试或计数保持未知，用户说明不作为验证通过依据。\n\n${list([...runs, ...taskEvidence])}\n`;
}
function gitMarkdown(snapshot: DeliverySnapshot): string {
  return `# Git 变更摘要\n\n工作区：${text(snapshot.git?.workspacePath)}\n\n分支：${text(snapshot.git?.branch)}\n\nHEAD：${text(snapshot.git?.headSha)}\n\nDiff 指纹：${text(snapshot.git?.diffFingerprint)}\n\n${snapshot.git?.truncated ? '注意：Git 结果存在截断，不能视为完整范围。\n\n' : ''}${snapshot.gitWarning ? `读取提示：${snapshot.gitWarning}\n\n` : ''}${list(snapshot.git?.files.map(file => `${file.status} ${line(file.path)}${file.layer ? `（${file.layer}）` : ''}`) ?? [])}\n`;
}
function reviewMarkdown(snapshot: DeliverySnapshot): string {
  return `# 代码审查\n\n${list(snapshot.impacts.map(report => `影响报告 ${report.id} · ${report.status} · 指纹 ${report.diffFingerprint ?? '未知'}`))}\n\n${list(snapshot.reviews.flatMap(run => [`审查 ${run.id} · ${run.status} · 指纹 ${run.diffFingerprint}`, ...run.findings.map(finding => `Finding ${finding.id} · ${finding.severity} / ${finding.confidence} / ${finding.status} · ${line(finding.title)} · ${finding.filePath ?? '未定位'}${finding.startLine ? `:${finding.startLine}` : ''} · 证据 ${finding.evidenceRefs.join(', ') || '未提供'}`)]))}\n\n未记录审查不等于审查通过；静态推断或模型建议不等于已验证问题。\n`;
}
export function renderDeliverySummary(snapshot: DeliverySnapshot, revision: number): string {
  return `# 交付摘要 · 修订 ${revision}\n\n项目：${snapshot.project.name}（${snapshot.project.id}）\n\n任务：${snapshot.taskId}\n\n采集时间：${snapshot.capturedAt}\n\n## 任务目标\n\n${text(snapshot.goal)}\n\n${snapshot.jira ? `Jira：${snapshot.jira.key} · ${snapshot.jira.summary}\n\n状态：${snapshot.jira.status} · Jira 更新时间：${snapshot.jira.updated ?? '未知'} · 抓取时间：${snapshot.jira.fetchedAt}\n\n` : ''}${snapshot.jiraWarning ? `Jira 提示：${snapshot.jiraWarning}\n\n` : ''}## 实现内容\n\n${list(snapshot.tasks.map(task => `任务 ${task.id} · ${task.name} · 执行状态 ${task.status} · ${task.result?.summary ?? '未提供结果摘要'}`))}\n\n用户补充说明（未经平台验证）：\n\n${text(snapshot.implementationNotes)}\n\n## 计划与版本\n\n${list(snapshot.plans.map(({ plan, steps }) => `计划 ${plan.id} · 修订 ${plan.revision} · ${plan.status} · ${steps.length} 步`))}\n\n${gitMarkdown(snapshot)}\n${verificationMarkdown(snapshot)}\n${reviewMarkdown(snapshot)}\n## 遗留事项、风险与建议\n\n${text(snapshot.remainingItems)}\n\n${list(snapshot.tasks.flatMap(task => (task.result?.unresolved ?? []).map(item => `${task.id}：${item}`)))}\n\n## 关联附件\n\n默认不包含客户源文件、完整代码、凭据、环境配置和原始日志。文件清单、SHA256 与排除项见 manifest.json。\n`;
}

function unsafeAttachmentName(name: string): boolean {
  return !name || name.length > 180 || name.includes('..') || /[\x00-\x1f\x7f/\\:]/.test(name)
    || /(?:^\.env(?:\.|$)|secret|credential|password|token|appsettings|\.pem$|\.pfx$|\.key$|id_rsa|^config\.)/i.test(name);
}
/** 纯内存、可复现的 ZIP 交付包构建；不会读取仓库或任意本地路径。 */
export function buildDeliveryPackage(snapshot: DeliverySnapshot, options: DeliveryBuildOptions, attachments: DeliveryAttachment[] = []): { bytes: Uint8Array; sha256: string; markdown: string; manifest: DeliveryManifest } {
  if (!Number.isSafeInteger(options.revision) || options.revision < 1) throw new Error('交付包修订必须为正整数');
  const markdown = renderDeliverySummary(snapshot, options.revision);
  const rawSnapshot = JSON.stringify(snapshot, null, 2);
  const files: Record<string, Uint8Array> = Object.create(null);
  files['README_交付摘要.md'] = strToU8(markdown);
  files['需求与实现说明.md'] = strToU8(`# 需求与实现说明\n\n目标：${text(snapshot.goal)}\n\n用户说明（未经平台验证）：\n\n${text(snapshot.implementationNotes)}\n`);
  files['Git变更摘要.md'] = strToU8(gitMarkdown(snapshot));
  files['验证报告/验证汇总.md'] = strToU8(verificationMarkdown(snapshot));
  files['代码审查报告.md'] = strToU8(reviewMarkdown(snapshot));
  files['遗留问题与风险.md'] = strToU8(`# 遗留问题与风险\n\n${text(snapshot.remainingItems)}\n`);
  files['evidence-snapshot.json'] = strToU8(rawSnapshot);
  const excluded: DeliveryManifest['excluded'] = [];
  let total = Object.values(files).reduce((sum, file) => sum + file.byteLength, 0);
  for (const attachment of attachments) {
    let reason = '';
    if (unsafeAttachmentName(attachment.name)) reason = '敏感文件名或不安全路径';
    else if (!options.includeAttachments) reason = '默认不包含可选附件';
    else if (attachment.kind === 'repository_code') reason = '不包含完整仓库代码';
    else if (attachment.kind === 'customer_source' && !options.includeCustomerSource) reason = '默认不包含客户源数据';
    else if (attachment.bytes.byteLength > 8 * 1024 * 1024) reason = '单个附件超过 8 MiB';
    else if (files[`附件/${attachment.name}`]) reason = '附件名称重复';
    if (reason) { excluded.push({ name: attachment.name, reason }); continue; }
    total += attachment.bytes.byteLength;
    files[`附件/${attachment.name}`] = Uint8Array.from(attachment.bytes);
  }
  if (total > 32 * 1024 * 1024) throw new Error('交付包未压缩内容超过 32 MiB，请缩小证据范围');
  const manifest: DeliveryManifest = { schemaVersion: 1, taskId: snapshot.taskId, revision: options.revision, generatedAt: snapshot.capturedAt, sourceSnapshotSha256: deliveryHash(rawSnapshot), files: Object.entries(files).map(([name, bytes]) => ({ name, size: bytes.byteLength, sha256: deliveryHash(bytes) })), excluded };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  const captured = new Date(snapshot.capturedAt);
  if (!Number.isFinite(captured.valueOf()) || captured.getUTCFullYear() < 1980 || captured.getUTCFullYear() > 2107) throw new Error('交付证据采集时间无效');
  const bytes = zipSync(files, { level: 6, mtime: captured });
  return { bytes, sha256: deliveryHash(bytes), markdown, manifest };
}
