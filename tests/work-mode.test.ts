import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from '../packages/storage/src';

test('交付项目与会话按模式持久化隔离并禁止跨模式绑定', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-work-mode-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  try {
    const project = store.createDeliveryTaskProject('佛山工厂交付');
    assert.equal(project.name, '佛山工厂交付');
    assert.equal('path' in project, false);

    store.saveSession({ id: 'development-session', workMode: 'development', title: '研发会话', workspacePath: root, createdAt: '2026-11-26T00:00:00Z', status: 'idle', model: 'test' });
    store.saveSession({ id: 'delivery-session', workMode: 'delivery', deliveryProjectId: project.id, title: '交付会话', workspacePath: root, createdAt: '2026-11-26T00:00:01Z', status: 'idle', model: 'test' });

    assert.equal(store.getSession('development-session')?.workMode, 'development');
    assert.equal(store.getSession('development-session')?.deliveryProjectId, undefined);
    assert.equal(store.getSession('delivery-session')?.workMode, 'delivery');
    assert.equal(store.getSession('delivery-session')?.projectId, undefined);
    assert.deepEqual(store.listDeliveryTaskProjects().map(item => item.id), [project.id]);

    assert.throws(() => store.saveSession({ id: 'invalid-delivery', workMode: 'delivery', projectId: 'git-project', title: '错误交付绑定', workspacePath: root, createdAt: '2026-11-26T00:00:02Z', status: 'idle', model: 'test' }), /不能绑定 Git 项目/);
    assert.throws(() => store.saveSession({ id: 'invalid-development', workMode: 'development', deliveryProjectId: project.id, title: '错误研发绑定', workspacePath: root, createdAt: '2026-11-26T00:00:03Z', status: 'idle', model: 'test' }), /不能绑定交付项目/);
    assert.throws(() => store.saveSession({ ...store.getSession('delivery-session')!, workMode: 'development' }), /工作模式创建后不能变更/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
