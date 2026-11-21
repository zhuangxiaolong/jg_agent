import { FileBlob, PresentationFile } from "@oai/artifact-tool";
const path = "D:/jinggong-agent/.pptx-work/build/candidate.pptx";
const out = "D:/jinggong-agent/.pptx-work/build/candidate2.pptx";
const p = await PresentationFile.importPptx(await FileBlob.load(path));
const setText = (id, text) => { const s=p.resolve(id); s.text = text; };
setText('sh/sryl4zqx','第二战区2027年度经营目标\n达成行动方案');
setText('sh/fu94fe98','利润质量与现金流优先 · AI赋能经营 · PMO闭环支撑');
setText('sh/vmdcj2xw','综合管理组支撑第二战区经营目标 · 2026年11月14日');
try { p.resolve('sh/utg3698n').fill = '#EFF9F3'; } catch {}
for (const id of ['sh/wn6dc7eh','sh/hofulsf2','sh/ul4vaxgb']) {
  try { p.resolve(id).text.color = '#16301F'; } catch {}
}
try { p.resolve('sh/sryl4zqx').text.style = { fontSize: 34, bold: true, color: '#16301F', typeface: 'Microsoft YaHei', autoFit: 'shrinkText' }; } catch {}
try { p.resolve('sh/fu94fe98').text.style = { fontSize: 15, bold: true, color: '#00B050', typeface: 'Microsoft YaHei', autoFit: 'shrinkText' }; } catch {}
await (await PresentationFile.exportPptx(p)).save(out);
console.log('exported',out);
