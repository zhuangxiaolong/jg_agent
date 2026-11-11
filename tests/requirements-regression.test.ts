import test from 'node:test';
import assert from 'node:assert/strict';
import type { JiraIssue } from '../packages/domain/src';
import { createDefaultRequirementAdmission } from '../packages/requirements/src';

const base = (summary: string, description: string, overrides: Partial<JiraIssue> = {}): JiraIssue => ({
  id: 'sample', key: 'DEMO-1', summary, description, status: 'Open', issueType: 'Story',
  url: 'https://jira.example.invalid/browse/DEMO-1', fetchedAt: '2026-11-10T01:00:00.000Z', attachments: [], ...overrides,
});

const uiSamples = [
  ['调整保存按钮文案', '登录页底部的保存按钮文案改为“提交”，仅在登录表单显示，使用简体中文。'],
  ['修改页面提示语', '登录页错误提示语改为“密码错误”，仅在登录窗口显示，使用中文。'],
  ['优化列表布局', '商品列表页面列宽调整为名称200px、编码120px，仅在桌面端商品列表使用。'],
  ['修改弹窗颜色', '库存详情页弹窗使用品牌色#336699，仅对库存详情弹窗生效。'],
  ['增加页面空状态', '订单列表页空状态显示“暂无订单”，仅在订单列表无数据时显示，使用中文。'],
  ['修正字段标签', '客户编辑页“客户编号”字段标签改为“客户编码”，仅此页面生效，使用中文。'],
  ['优化交互提示', '库存查询列表页鼠标悬停显示“查看库存批次”，仅在桌面端显示，使用中文。'],
  ['调整表单样式', '设置页面表单输入框边距统一为8px，仅限设置表单。'],
  ['修改导航名称', '仓库首页导航名称改为“库存查询”，仅对仓库首页导航生效，使用中文。'],
  ['调整字体大小', '工作台页面标题字体大小调整为14px，仅在工作台标题生效。'],
].map(([summary, description]) => base(summary, description));

const wmsSamples = [
  base('WMS库存扣减', '库存出库后扣减库存。'),
  base('WMS拣货库存', '拣货完成时扣减库存。'),
  base('WMS库存冻结', '冻结库存后需要扣减。'),
  base('WMS预占库存', '系统支持库存预占。'),
  base('WMS库存扣减异常', '库存扣减失败时记录异常。'),
  base('WMS出库扣减', '出库流程自动减少库存。'),
  base('WMS重复扫描', '重复扫码会再次扣减库存。'),
  base('WMS库存状态', '可用库存扣减，冻结库存不能扣减。'),
].map(issue => ({ ...issue, key: `WMS-${issue.summary.length}` }));

const mesSamples = [
  base('MES生产报工', '新增报工功能。'), base('MES完工报工', '完工后进行报工。'), base('MES工序报工', '按工序提交报工。'),
  base('MES数量校验', '校验报工数量。'), base('MES合格品报工', '支持合格品报工。'), base('MES不合格品报工', '支持不合格品报工。'),
  base('MES重复报工', '重复报工需要拦截。'), base('MES工单报工', '在工单上完成报工。'),
].map(issue => ({ ...issue, key: `MES-${issue.summary.length}` }));

const otherSamples = [
  base('接口超时处理', '增加接口失败重试。'), base('新增库存报表', '按仓库查询库存。'), base('数据表字段', '增加状态字段。'),
  base('配置部署', '增加一个配置项。'), base('代码重构', '拆分服务类。'), base('修复登录错误', '修复登录时报错。'),
  base('通用需求', '完善业务流程。'), base('设备接口对接', '对接设备接口。'), base('历史数据迁移', '迁移历史数据。'), base('权限调整', '调整角色权限。'),
].map(issue => ({ ...issue, key: `GEN-${issue.summary.length}` }));

test('首期本地规则回归集覆盖 30 个脱敏样本及关键准入结论', () => {
  const all = [...uiSamples, ...wmsSamples, ...mesSamples, ...otherSamples];
  assert.ok(all.length >= 30, `回归样本数为 ${all.length}`);

  for (const issue of uiSamples) {
    const result = createDefaultRequirementAdmission(issue, 'WMS');
    assert.equal(result.implementationAllowed, true, issue.summary);
    assert.equal(result.items.some(item => item.itemKey.startsWith('REQ-WMS-') || item.itemKey.startsWith('REQ-MES-')), false, issue.summary);
  }

  const incompleteUi = createDefaultRequirementAdmission(base('调整页面文案', '把按钮改一下。'), 'MES6');
  const uiScope = incompleteUi.items.find(item => item.itemKey === 'REQ-UI-SCOPE');
  assert.equal(uiScope?.status, 'missing');
  assert.equal(uiScope?.blockingStage, 'implementation');
  assert.match(uiScope?.question ?? '', /页面或功能位置/);
  assert.match(uiScope?.question ?? '', /目标文案或具体显示行为/);
  assert.match(uiScope?.question ?? '', /语言或显示范围/);
  assert.equal(incompleteUi.implementationAllowed, false);

  for (const issue of wmsSamples) {
    const result = createDefaultRequirementAdmission(issue, 'WMS');
    assert.equal(result.status, 'blocked', issue.summary);
    assert.equal(result.implementationAllowed, false, issue.summary);
    assert.ok(result.items.some(item => item.itemKey === 'REQ-WMS-STOCK-DEDUCTION-TIMING'), issue.summary);
  }

  const wmsDefined = createDefaultRequirementAdmission(base('WMS库存扣减', '库存扣减时点为出库确认，库存状态为可用量，重复扫描按幂等处理，异常短装拒绝。验收标准：出库确认后库存减少。'), 'WMS');
  assert.equal(wmsDefined.status, 'ready');
  assert.equal(wmsDefined.implementationAllowed, true);

  for (const issue of mesSamples) {
    const result = createDefaultRequirementAdmission(issue, issue.summary.includes('合格') ? 'MES6' : 'MES5');
    assert.equal(result.status, 'blocked', issue.summary);
    assert.equal(result.implementationAllowed, false, issue.summary);
    assert.ok(result.items.some(item => item.itemKey === 'REQ-MES-REPORT-QUANTITY-BASIS'), issue.summary);
  }

  const mesAmbiguous = createDefaultRequirementAdmission(base('MES生产报工', '报工数量按投入数还是完工数，需确认。'), 'MES6');
  assert.equal(mesAmbiguous.items.find(item => item.itemKey === 'REQ-MES-REPORT-QUANTITY-BASIS')?.status, 'ambiguous');
  assert.equal(mesAmbiguous.status, 'blocked');

  const mesDefined = createDefaultRequirementAdmission(base('MES生产报工', '报工数量按合格数，合格数量不能超过工单剩余数。验收标准：合格报工成功。'), 'MES5');
  assert.equal(mesDefined.items.some(item => item.itemKey === 'REQ-MES-REPORT-QUANTITY-BASIS'), true);
  assert.equal(mesDefined.status, 'ready');

  for (const issue of otherSamples) {
    const result = createDefaultRequirementAdmission(issue, issue.summary.includes('库存') ? 'WMS' : '通用');
    assert.equal(result.status, 'blocked', issue.summary);
    assert.equal(result.implementationAllowed, false, issue.summary);
    assert.ok(result.items.some(item => item.itemKey === 'REQ-GEN-LOCAL-RULE-COVERAGE'), issue.summary);
  }

  const attachmentOnly = createDefaultRequirementAdmission(base('按附件实现', '详见附件中的流程图和规则。', {
    attachments: [{ id: 'att-1', name: '规则.png', mimeType: 'image/png', size: 10, url: 'https://jira.invalid/att-1', imageWarning: '下载失败' }],
  }), 'MES6');
  assert.equal(attachmentOnly.status, 'blocked');
  assert.equal(attachmentOnly.items.find(item => item.itemKey === 'REQ-GEN-ATTACHMENT-READABILITY')?.blockingStage, 'design');

  const noAcceptance = createDefaultRequirementAdmission(base('通用小改动', '调整内部日志输出。'), '通用');
  assert.equal(noAcceptance.status, 'blocked');
  assert.equal(noAcceptance.implementationAllowed, false);
  assert.deepEqual(noAcceptance.stageBlockers, ['design', 'testing']);
});

