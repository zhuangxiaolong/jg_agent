import test from 'node:test';
import assert from 'node:assert/strict';
import { applicableDocuments, evaluateRequirements, buildDeveloperContext, parsePolicy } from '../packages/policy/src';
import type { ManagedDocument } from '../packages/domain/src';
function document(content: string, name = '规则.json', system: ManagedDocument['system'] = '通用'): ManagedDocument {
  return { id: name, kind: 'requirement', system, name, content, digest: 'digest', createdAt: new Date().toISOString(), enabled: true };
}
test('开发规则真实阻断违规文本和必需文件删除，不执行不受信任正则', async () => {
  const doc = document(JSON.stringify({ rules: [{ type: 'forbid-text', glob: '**/*.ts', text: 'eval(' }, { type: 'require-text', glob: 'src/*.ts', text: 'export ' }, { type: 'require-file', path: 'README.md' }] }));
  const results = await evaluateRequirements([doc], new Map([['src/index.ts', 'eval("123")'], ['README.md', null]]), async () => false);
  assert.equal(results[0].status, 'fail'); assert.equal(results[0].details.length, 3);
  assert.equal((await evaluateRequirements([doc], new Map([['src/index.ts', 'export const value = 1;']]), async () => true))[0].status, 'pass');
});
test('不同MES版本隔离，文字要求需人工复核，完整注入不静默截断', async () => {
  const docs = [document('遵循仓库规范', '规范.md'), document('MES5要求', 'MES5.md', 'MES5'), document('MES6要求', 'MES6.md', 'MES6')];
  const applicable = applicableDocuments(docs, { system: 'MES5' });
  assert.equal(applicable.length, 2);
  assert.equal((await evaluateRequirements(applicable, new Map(), async () => true))[0].status, 'review');
  const context = buildDeveloperContext(applicable, []);
  assert.ok(context.includes('MES5要求') && !context.includes('MES6要求'));
  assert.match(context, /需求准入状态、缺失检查项和代码方案记录仅作提示/);
  assert.doesNotMatch(context, /暂停代码修改|仍须发布初步修改方案|完成所有人工复核/);
  assert.throws(() => buildDeveloperContext([document(JSON.stringify({ rules: [{ type: 'shell', command: 'evil' }] }))], []), /机器规则/);
  assert.throws(() => buildDeveloperContext([document('a'.repeat(180001), '太大.md')], []), /不会静默/);
});
test('Windows大小写不能绕过必需文件保护，重复glob匹配有界', async () => {
  const doc = document(JSON.stringify({ rules: [{ type: 'require-file', path: 'README.md' }, { type: 'forbid-text', glob: '**/'.repeat(24) + 'z.ts', text: '禁止' }] }));
  const started = performance.now();
  const result = await evaluateRequirements([doc], new Map([['./readme.md', null], ['a/'.repeat(30) + 'x.ts', '禁止']]), async () => true, 'write');
  assert.equal(result[0].status, 'fail');
  assert.ok(performance.now() - started < 1000);
  const scoped = document(JSON.stringify({ rules: [{ type: 'forbid-text', glob: 'src/*.ts', text: '禁止' }] }));
  assert.equal((await evaluateRequirements([scoped], new Map([['./src/index.ts', '禁止']]), async () => true, 'write'))[0].status, 'fail');
});

test('规则自身的./路径归一后在写入和提交阶段阻断违规内容及必需文件删除', async () => {
  const scoped = document(JSON.stringify({ rules: [{ type: 'forbid-text', glob: './src/./*.ts', text: '禁止内容' }] }));
  const required = document(JSON.stringify({ rules: [{ type: 'require-file', path: './docs/./README.md' }] }));
  assert.equal((parsePolicy(scoped)!.rules[0] as { glob: string }).glob, 'src/*.ts');
  assert.equal((parsePolicy(required)!.rules[0] as { path: string }).path, 'docs/README.md');
  for (const phase of ['write', 'commit'] as const) {
    assert.equal((await evaluateRequirements([scoped], new Map([['src/index.ts', '禁止内容']]), async () => true, phase))[0].status, 'fail');
    assert.equal((await evaluateRequirements([scoped], new Map([['./src/index.ts', '符合规则的正文']]), async () => true, phase))[0].status, 'pass');
    const deletion = await evaluateRequirements([required], new Map([['docs/README.md', null]]), async () => true, phase);
    assert.equal(deletion[0].status, 'fail');
    assert.match(deletion[0].details[0], /不能删除必需文件 docs\/README.md/);
  }
});

test('规则路径移除.段不放行绝对路径、越界、空段、Git元数据和反斜杠', () => {
  for (const path of ['/./src/file.ts', 'C:/./src/file.ts', './src/../file.ts', './src//file.ts', './.git/config', './.GIT/config', '.\\src\\file.ts', '.', './']) {
    for (const rule of [{ type: 'require-file', path }, { type: 'forbid-text', glob: path, text: '禁止内容' }]) {
      assert.throws(() => parsePolicy(document(JSON.stringify({ rules: [rule] }))), /机器规则格式/, path);
    }
  }
});
