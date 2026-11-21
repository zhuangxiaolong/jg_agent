import type { ManualLocator, ManualChunk, OperationManual } from './index';

export function formatManualLocator(locator: ManualLocator): string {
  if (locator.kind === 'pdf') return `第 ${locator.page} 页`;
  if (locator.kind === 'pptx') return `第 ${locator.slide} 张幻灯片`;
  if (locator.kind === 'xlsx') return `工作表“${locator.sheet}”${locator.range ? ` · ${locator.range}` : ''}`;
  if (locator.kind === 'docx' && locator.lineStart !== undefined) return `段落 ${locator.lineStart}${locator.lineEnd && locator.lineEnd !== locator.lineStart ? `–${locator.lineEnd}` : ''}`;
  if (locator.kind === 'text' && locator.lineStart !== undefined) return `第 ${locator.lineStart}–${locator.lineEnd ?? locator.lineStart} 行`;
  return locator.kind === 'html' ? 'HTML 正文' : '文档正文';
}

export function formatManualCitation(manual: OperationManual, chunk: ManualChunk): string {
  const version = manual.manualVersion ? ` ${manual.manualVersion}` : '';
  const section = chunk.sectionPath.length ? ` — ${chunk.sectionPath.join(' / ')}` : '';
  return `《${manual.name}${version}》— ${formatManualLocator(chunk.locator)}${section}`;
}
