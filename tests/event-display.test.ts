import test from 'node:test';
import assert from 'node:assert/strict';
import { compactAgentEvent, compactToolEvent } from '../apps/desktop/src/renderer/branding';

test('会话工具事件压缩为用户可读摘要并隐藏内部噪声', () => {
  assert.equal(compactToolEvent('已按完整开发配置允许当前任务执行。'), null);
  assert.equal(compactToolEvent('执行命令：dotnet build'), null);
  assert.equal(compactToolEvent('命令执行完成：dotnet build\n退出码：0\nBuild succeeded.\n' + '详细输出 '.repeat(100)), '命令已完成：dotnet build');
  assert.equal(compactToolEvent('命令执行完成：dotnet test\n退出码：1\n测试失败'), '命令执行失败（退出码 1）：dotnet test');
  assert.equal(compactToolEvent('已执行项目文件工具 read_project_file：src/AssemblyOperationController.cs SHA256=' + 'a'.repeat(64)), '读取项目文件：src/AssemblyOperationController.cs');
  assert.equal(compactToolEvent('已执行字典工具 search_dictionary：检索到 4 条 SHA256=' + 'b'.repeat(64)), '检索数据字典：检索到 4 条');
  assert.equal(compactAgentEvent({ type: 'status', text: '工具链已更新：内部兼容说明' }), null);
  assert.equal(compactAgentEvent({ type: 'tool', text: '已执行项目文件工具 list_project_files：20 个文件' }), null);
  assert.equal(compactAgentEvent({ type: 'tool', text: '已执行项目文件工具 read_project_file：src/main.ts' }), null);
  assert.equal(compactAgentEvent({ type: 'tool', text: '已执行字典工具 search_dictionary：检索到 4 条' }), null);
  assert.equal(compactAgentEvent({ type: 'tool', text: '已执行字典工具 read_dictionary：表结构说明' }), null);
  assert.equal(compactAgentEvent({ type: 'tool', text: '已执行项目文件工具 write_project_file：src/main.ts' }), '修改项目文件：src/main.ts');
  assert.equal(compactAgentEvent({ type: 'tool', text: '已发布代码修改方案：2 个文件' }), '已发布代码修改方案：2 个文件');
  assert.equal(compactAgentEvent({ type: 'tool', text: 'item/reasoning: completed' }), null);
  assert.equal(compactAgentEvent({ type: 'message', text: '正式分析结果' }), '正式分析结果');
});
