import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '../packages/domain/src';
import { latestRunningIndicator, runningIndicatorDetails } from '../apps/desktop/src/renderer/running-indicator';

function event(id: string, type: AgentEvent['type'], text: string, createdAt = `2026-11-11T00:00:0${id}Z`): AgentEvent {
  return { id, sessionId: 'session-1', type, text, createdAt };
}

test('运行中指示器只保留可读的最新工具进度', () => {
  const details = runningIndicatorDetails([
    event('1', 'status', 'running'),
    event('2', 'tool', '已执行项目文件工具 read_project_file：src/main.ts'),
    event('3', 'tool', '命令执行完成：dotnet build\n退出码：0'),
    event('4', 'tool', '命令执行完成：dotnet test\n退出码：0'),
  ]);
  assert.deepEqual(details.map(item => item.text), ['读取项目文件：src/main.ts', '命令已完成：dotnet build', '命令已完成：dotnet test']);
  assert.equal(latestRunningIndicator(details.map(item => event(item.id, item.type === 'response' ? 'message' : item.type, item.text))), '命令已完成：dotnet test');
});

test('运行中指示器保留错误信息并去重', () => {
  const details = runningIndicatorDetails([
    event('1', 'error', '连接失败'),
    event('2', 'error', '连接失败'),
    event('3', 'status', '工具链已更新：内部说明'),
  ]);
  assert.equal(details.length, 1);
  assert.equal(details[0].text, '运行错误：连接失败');
  assert.equal(latestRunningIndicator([]), '正在准备运行环境…');
});

test('运行中指示器实时汇总连续文本增量并展示等待确认状态', () => {
  const events = [
    event('1', 'status', 'running'),
    event('2', 'delta', '正在分析'),
    event('3', 'delta', '项目结构和调用链。'),
  ];
  assert.equal(latestRunningIndicator(events), '回复进展：正在分析项目结构和调用链。');
  events.push(event('4', 'status', 'waiting-approval'));
  assert.equal(latestRunningIndicator(events), '等待确认');
  assert.deepEqual(runningIndicatorDetails(events).map(item => item.type), ['response', 'status']);
});

test('运行中指示器显示日常命令进度但不重复上轮信息', () => {
  const events = [event('1', 'message', '上一轮回复'), event('2', 'status', 'completed'), event('3', 'user', '新任务'), event('4', 'status', 'running')];
  assert.equal(latestRunningIndicator(events), '正在准备运行环境…');
  events.push(event('5', 'tool', '执行命令：rg -n name src'));
  assert.equal(latestRunningIndicator(events), '正在执行：rg -n name src');
  events.push(event('6', 'tool', '命令执行完成：rg -n name src\n退出码：0\n找到 2 条'));
  assert.equal(latestRunningIndicator(events), '命令已完成：rg -n name src');
  assert.equal(runningIndicatorDetails(events, 1).length, 1);
});

test('运行中指示器限制回复摘要且过滤内部核验消息', () => {
  const events = [event('1', 'delta', '进展'.repeat(300)), event('2', 'message', '### 代码变更核验\n内部核验')];
  const latest = latestRunningIndicator(events);
  assert.ok(latest.length <= 246);
  assert.match(latest, /^回复进展：…/);
  assert.equal(runningIndicatorDetails(events).length, 1);
});
