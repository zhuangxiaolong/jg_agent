import { FileBlob, PresentationFile } from "@oai/artifact-tool";
const input="D:/jinggong-agent/.pptx-work/build/candidate3.pptx";
const output="D:/jinggong-agent/.pptx-work/build/candidate4.pptx";
const p=await PresentationFile.importPptx(await FileBlob.load(input));
const edits=[
 ["sh/fu94fe98","利润质量优先，PMO以数据和AI支撑经营闭环"],
 ["sh/hofulsf2","36人增至54人完整配置"],
 ["sh/ozy1ofad","综合管理组以预算管理、经营数据和PMO机制支撑战区回款目标，服务公司2027年净利率20.38%的战略方向。"],
 ["sh/hcvy14ne","每周复核到账和未来90天预测。每月核对产值、回款、毛利和费用。每季度依据经营结果和交付瓶颈调整资源。"],
 ["sh/ax4zax0n","经营结论\n回款、人效和利润质量要同步改善：\n1. 存量项目按节点兑现回款\n2. 立项/变更先核毛利和付款条件\n3. 按项目归集人天和费用\n4. AI场景先形成付费订单，再复制"],
 ["sh/r6lojmds","568万元由实际项目所属组认领。同步核对现金流、预算和毛利，按项目成本与付款节点滚动校准，避免平均分摊。"],
 ["sh/atc7epon","1. PMO规划经营管理AI系统，统一合同、项目、财务、人事数据口径\n2. 财务统一应收口径，月度跟踪预算和费用偏差\n3. 人力维护招聘、编制和绩效台账，考核兼顾签单、收款和毛利\n4. 测试和质量岗核验上线及验收证据，督办重大风险\n5. 经营看板支持决策，战区对项目经营结果负责"],
 ["sh/365472tg","PMO标准、经营数据、预算绩效、质量和重大风险"],
 ["sh/yhg7epsj","季度回款目标：Q1 700万、Q2 1,000万、Q3 1,200万、Q4 1,350万"],
];
for(const [id,value] of edits) p.resolve(id).text=value;
await (await PresentationFile.exportPptx(p)).save(output);
console.log(`已导出 ${output}; 修改文本 ${edits.length} 处`);
