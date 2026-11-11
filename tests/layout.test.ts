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
    assert.deepEqual(store.getLayout(), { leftVisible: true, rightVisible: true, bottomVisible: false, leftWidth: 220, rightWidth: 420, bottomHeight: 180 });
    store.savePreferences({ theme: 'purple', style: 'minimal', completionSound: 'chime' });
    for (const layout of [
      { leftVisible: false, rightVisible: true, bottomVisible: true, leftWidth: 200, rightWidth: 400, bottomHeight: 170 },
      { leftVisible: false, rightVisible: false, bottomVisible: true, leftWidth: 200, rightWidth: 350, bottomHeight: 170 },
      { leftVisible: false, rightVisible: false, bottomVisible: false, leftWidth: 200, rightWidth: 350, bottomHeight: 120 }
    ]) { store.saveLayout(layout); assert.deepEqual(store.getLayout(), layout); }
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.getLayout(), { leftVisible: false, rightVisible: false, bottomVisible: false, leftWidth: 200, rightWidth: 350, bottomHeight: 120 });
    assert.deepEqual(store.getPreferences(), { theme: 'purple', style: 'minimal', completionSound: 'chime', updateMode: 'automatic' });
    assert.throws(() => store.saveLayout({ leftVisible: 'false', rightVisible: false, bottomVisible: false } as never), /布尔/);
    assert.equal(layoutSchema.safeParse({ leftVisible: 'false', rightVisible: false, bottomVisible: false }).success, false);
    assert.equal(layoutSchema.safeParse({ leftVisible: false, rightVisible: false, bottomVisible: false, apiKey: secret }).success, false);
    assert.equal(layoutSchema.safeParse({ leftVisible: true, rightVisible: true, bottomVisible: true, leftWidth: 179 }).success, false);
    assert.equal(layoutSchema.safeParse({ leftVisible: true, rightVisible: true, bottomVisible: true, leftWidth: 300, rightWidth: 380, bottomHeight: 200 }).success, true);
    store.saveLayout({ leftVisible: true, rightVisible: true, bottomVisible: true, apiKey: secret } as never);
    assert.equal((await readFile(filename)).includes(Buffer.from(secret)), false);
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.getLayout(), { leftVisible: true, rightVisible: true, bottomVisible: true, leftWidth: 220, rightWidth: 420, bottomHeight: 180 });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('重命名项目统一历史自动标题，保留普通会话和自定义标题', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-default-mode-'));
  const store = await LocalStore.open(path.join(root, 'agent.db'));
  try {
    store.saveProject({ id: 'project', name: '原项目', path: 'D:\\fixture', branch: 'main' });
    const base = { projectId: 'project', workspacePath: 'D:\\worktree', branch: 'agent/session', status: 'idle' as const, createdAt: '2026-11-05T00:00:00Z', model: '' };
    store.saveSession({ ...base, id: 'develop', title: '原项目 · 隔离开发' });
    store.saveSession({ ...base, id: 'read', title: '原项目 · 只读分析' });
    store.saveSession({ ...base, id: 'normal', title: '原项目 · 会话 2026/11/11 10:20' });
    store.saveSession({ ...base, id: 'legacy', title: '历史标题' });
    store.renameProject('project', '新项目');
    assert.equal(store.getSession('develop')!.title, '新项目 · 会话');
    assert.equal(store.getSession('read')!.title, '新项目 · 会话');
    assert.equal(store.getSession('normal')!.title, '新项目 · 会话 2026/11/11 10:20');
    assert.equal(store.listSessions().some(session => Object.hasOwn(session, 'mode')), false);
    assert.equal(store.getSession('legacy')!.title, '历史标题');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
