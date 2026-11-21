import { FileBlob, PresentationFile } from "@oai/artifact-tool";
import fs from "node:fs/promises";

const input = "C:/Users/Administrator/Desktop/第二战区2027年度经营目标达成行动方案_周六会议版.pptx";
const candidate = "D:/jinggong-agent/.pptx-work/build/candidate.pptx";
const p = await PresentationFile.importPptx(await FileBlob.load(input));

const edits = new Map([
  ["THE SECOND WAR ZONE / 2027", "ANNUAL STRATEGY REVIEW"],
  ["第二战区", "2027年度经营目标"],
  ["2027年度经营目标 达成行动方案", "第二战区2027年度经营目标\n达成行动方案"],
  ["4,250万元回款挑战目标 · 季度作战计划 · 责任到组到人", "利润质量与现金流优先 · AI赋能经营 · PMO闭环支撑"],
  ["周六经营规划讨论会 | 2026年11月14日", "综合管理组支撑第二战区经营目标 · 2026年11月14日"],
  ["本次会议要形成5项明确决策", "综合管理组先统一经营口径，再把目标压到项目"],
  ["先正视经营压力：人数增加50%，回款目标接近4倍", "经营压力的本质：回款接近4倍，人均效率必须提升"],
  ["4250万元回款必须先说清楚钱从哪里来", "从目标到现金：每一笔回款都要有合同、节点与责任人"],
  ["年度目标：交付产值4,000万元，回款挑战4,250万元", "经营目标拆解：交付产值、回款与组织责任三张表对齐"],
  ["季度回款目标：700万 → 1,000万 → 1,200万 → 1,350万", "季度经营节奏：700万 → 1,000万 → 1,200万 → 1,350万"],
  ["季度×组别：先建立责任参考，再用项目清单落地", "季度×组别：用数据看板把责任参考落到项目清单"],
  ["组织责任：双组稳住基本盘，AI专项组承担新增长", "组织与资源：用人力配置支撑利润质量与交付兑现"],
  ["共享开发中心与公司综合组：交付资源必须服务于回款节点", "综合管理支撑经营系统：资源、质量与回款节点同频"],
  ["战区负责人：从“盯项目细节”转向“盯经营结果与关键客户”", "经营负责人：从“盯项目细节”转向“盯经营结果与关键客户”"],
  ["管理机制：每周盯现金、每月算经营、每季调资源", "治理节奏：周看现金、月算经营、季调资源"],
  ["回款预警：用领先指标管理，不等季度末才发现缺口", "预警机制：用领先指标管理经营风险"],
  ["会后30天：把会议共识变成项目级执行清单", "会后30天：综合管理组把会议共识变成项目级执行清单"],
  ["附：项目现金流拆解表｜这是4250万元目标的底层依据", "附：项目现金流拆解表｜综合管理组运营底账"],
]);

const inspect = await p.inspect({select:'$.slides[*]',include:['id','index','elements.id','elements.kind','elements.text']});
const found = new Map();
for (const line of inspect.ndjson.split('\n')) {
  if (!line.trim()) continue;
  const slide = JSON.parse(line);
  for (const el of slide.elements ?? []) {
    const raw = typeof el.text === 'string' ? el.text.replace(/\r/g,'') : '';
    if (!raw) continue;
    found.set(raw, { id: el.id, slide: slide.index + 1 });
  }
}
for (const [oldText, newText] of edits) {
  const hit = found.get(oldText);
  if (!hit) { console.warn('未找到文案:', oldText); continue; }
  const shape = p.resolve(hit.id);
  shape.text.replace(oldText, newText);
  console.log(`替换第${hit.slide}页: ${oldText} => ${newText}`);
}

// 统一参考稿的绿系与白底语言，封面改为参考稿的简洁白底。
const cover = p.slides.getItem(0);
cover.background.fill = '#FFFFFF';
for (const id of ['sh/547294r6','sh/k3yl0zql','sh/7qp4be9c']) {
  try {
    const shape = p.resolve(id);
    shape.fill = '#FFFFFF';
    shape.line = { style: 'none' };
  } catch (e) { console.warn('封面背景元素处理失败', id, e.message); }
}

const coverTextIds = ['sh/65g3298r','sh/ts7md4r2','sh/sryl4zqx','sh/fu94fe98','sh/wn6dc7eh','sh/hofulsf2','sh/ul4vaxgb','sh/vmdcj2xw'];
for (const id of coverTextIds) {
  const shape = p.resolve(id);
  try { shape.text.color = '#16301F'; } catch {}
  try { shape.text.typeface = 'Microsoft YaHei'; } catch {}
}
try { p.resolve('sh/65g3298r').text.color = '#00B050'; } catch {}
try { p.resolve('sh/ts7md4r2').text.style = { fontSize: 26, bold: true, color: '#16301F', typeface: 'Microsoft YaHei' }; } catch {}
try { p.resolve('sh/sryl4zqx').text.style = { fontSize: 34, bold: true, color: '#16301F', typeface: 'Microsoft YaHei', autoFit: 'shrinkText' }; } catch {}
try { p.resolve('sh/fu94fe98').text.color = '#00B050'; } catch {}

// 页标题统一为参考稿的深绿，正文保留各页已有强调色。
for (let i = 1; i < p.slides.items.length; i++) {
  const slide = p.slides.getItem(i);
  const title = slide.shapes.items.find?.(() => false);
}
// 根据当前文本匹配每页首个长标题并设置深绿；不改动表格和图形颜色。
const after = await p.inspect({select:'$.slides[*]',include:['index','elements.id','elements.kind','elements.text']});
for (const line of after.ndjson.split('\n')) {
  if (!line.trim()) continue;
  const slide = JSON.parse(line);
  if (slide.index === 0) continue;
  const candidates = (slide.elements ?? []).filter(e => e.kind === 'textbox' && typeof e.text === 'string' && e.text.trim().length > 12);
  if (candidates.length) {
    const titleShape = p.resolve(candidates[0].id);
    try { titleShape.text.color = '#16301F'; } catch {}
    try { titleShape.text.bold = true; } catch {}
    try { titleShape.text.typeface = 'Microsoft YaHei'; } catch {}
  }
}

await (await PresentationFile.exportPptx(p)).save(candidate);
console.log('已导出', candidate);
