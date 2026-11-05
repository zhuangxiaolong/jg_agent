import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from '../packages/storage/src';
import { layoutSchema } from '../apps/desktop/src/main/security';

test('面板显示独立持久化，所有面板均可隐藏及恢复，拒绝非布尔值且不保存附加凭据', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-layout-'));
  const filename = path.join(root, 'agent.db'); let store = await LocalStore.open(filename);
  const secret = 'SYNTHETIC_LAYOUT_SECRET_NOT_PERSISTED';
  try {
    assert.deepEqual(store.getLayout(), { leftVisible: true, rightVisible: true, bottomVisible: true });
    store.savePreferences({ theme: 'purple', style: 'minimal' });
    for (const layout of [
      { leftVisible: false, rightVisible: true, bottomVisible: true },
      { leftVisible: false, rightVisible: false, bottomVisible: true },
      { leftVisible: false, rightVisible: false, bottomVisible: false }
    ]) { store.saveLayout(layout); assert.deepEqual(store.getLayout(), layout); }
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.getLayout(), { leftVisible: false, rightVisible: false, bottomVisible: false });
    assert.deepEqual(store.getPreferences(), { theme: 'purple', style: 'minimal' });
    assert.throws(() => store.saveLayout({ leftVisible: 'false', rightVisible: false, bottomVisible: false } as never), /布尔/);
    assert.equal(layoutSchema.safeParse({ leftVisible: 'false', rightVisible: false, bottomVisible: false }).success, false);
    assert.equal(layoutSchema.safeParse({ leftVisible: false, rightVisible: false, bottomVisible: false, apiKey: secret }).success, false);
    store.saveLayout({ leftVisible: true, rightVisible: true, bottomVisible: true, apiKey: secret } as never);
    assert.equal((await readFile(filename)).includes(Buffer.from(secret)), false);
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.getLayout(), { leftVisible: true, rightVisible: true, bottomVisible: true });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('重命名项目兼容新的隔离开发标题并保留既有只读会话模式', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-default-mode-'));
  const store = await LocalStore.open(path.join(root, 'agent.db'));
  try {
    store.saveProject({ id: 'project', name: '原项目', path: 'D:\\fixture', branch: 'main' });
    const base = { projectId: 'project', workspacePath: 'D:\\worktree', branch: 'agent/session', status: 'idle' as const, createdAt: '2026-11-05T00:00:00Z', model: '' };
    store.saveSession({ ...base, id: 'develop', title: '原项目 · 隔离开发', mode: 'develop' });
    store.saveSession({ ...base, id: 'read', title: '原项目 · 只读分析', mode: 'read' });
    store.saveSession({ ...base, id: 'legacy', title: '历史标题' });
    store.renameProject('project', '新项目');
    assert.equal(store.getSession('develop')!.title, '新项目 · 隔离开发');
    assert.equal(store.getSession('develop')!.mode, 'develop');
    assert.equal(store.getSession('read')!.mode, 'read');
    assert.equal(store.getSession('legacy')!.mode, undefined);
    assert.equal(store.getSession('legacy')!.title, '历史标题');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
