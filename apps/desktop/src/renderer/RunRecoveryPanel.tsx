import { useEffect, useState } from 'react';
import type { AgentRunCheckpoint, AgentRunRecord, DesktopApi, Session } from '../../../../packages/domain/src';
import { Icon } from './ui';
import './run-recovery.css';

const recoverableStatuses = new Set<AgentRunRecord['status']>(['interrupted', 'recovery_required']);

function dateText(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function RunRecoveryPanel({ api, session, disabled = false, onError }: { api: DesktopApi; session: Session; disabled?: boolean; onError: (reason: unknown) => void }) {
  const [runs, setRuns] = useState<AgentRunRecord[]>([]);
  const [checkpoints, setCheckpoints] = useState<Record<string, AgentRunCheckpoint | undefined>>({});
  const [busy, setBusy] = useState('');

  async function refresh() {
    if (!api.runLifecycle) return;
    const values = (await api.runLifecycle.list(session.id)).filter(run => recoverableStatuses.has(run.status));
    const entries = await Promise.all(values.map(async run => [run.id, (await api.runLifecycle!.checkpoints(session.id, run.id)).at(-1)] as const));
    setRuns(values);
    setCheckpoints(Object.fromEntries(entries));
  }

  useEffect(() => {
    void refresh().catch(onError);
  }, [api, session.id]);

  if (!api.runLifecycle || !runs.length) return null;

  async function act(run: AgentRunRecord, decision: 'continue' | 'open_workspace' | 'abandon') {
    const key = `${run.id}:${decision}`;
    setBusy(key);
    try {
      const checkpoint = checkpoints[run.id];
      await api.runLifecycle!.recover(session.id, run.id, decision);
      if (decision === 'continue') {
        const pending = checkpoint?.pending.slice(0, 8).join('；') || '复核上一轮尚未确认的工作区、工具调用和验证结果';
        const goal = checkpoint?.goal || '当前会话任务';
        await api.sendTurn(session.id, `请从已中断运行的检查点继续执行。原任务目标：${goal.slice(0, 1200)}。待处理事项：${pending.slice(0, 2400)}。先核对当前工作区和已有结果，再继续执行并补齐验证。`);
        await api.runLifecycle!.recover(session.id, run.id, 'abandon');
      }
      await refresh();
    } catch (reason) {
      onError(reason);
    } finally {
      setBusy('');
    }
  }

  return <section className="run-recovery-panel" aria-label="中断运行恢复">
    <div className="run-recovery-heading"><div><strong>发现未完成运行</strong><span>应用退出或 Runtime 中断后，先核对检查点再继续。</span></div><Icon name="alert" /></div>
    {runs.map(run => {
      const checkpoint = checkpoints[run.id];
      const action = (decision: 'continue' | 'open_workspace' | 'abandon') => `${run.id}:${decision}`;
      return <article className="run-recovery-item" key={run.id}>
        <div className="run-recovery-meta"><strong>{run.modelId || run.runtimeKind}</strong><span>{run.status === 'recovery_required' ? '待复核' : '已中断'} · {dateText(run.updatedAt)}</span></div>
        <p>{checkpoint?.goal || run.recoveryReason || '未保存可展示的任务目标，请先打开工作区人工核对。'}</p>
        {checkpoint?.pending.length ? <small>待处理：{checkpoint.pending.slice(0, 3).join('；')}</small> : null}
        <code>{run.workspacePath}</code>
        <div className="run-recovery-actions">
          <button type="button" className="primary-button" disabled={disabled || !!busy} onClick={() => void act(run, 'continue')}>{busy === action('continue') ? '正在恢复…' : '从检查点继续'}</button>
          <button type="button" className="secondary-button" disabled={disabled || !!busy} onClick={() => void act(run, 'open_workspace')}>{busy === action('open_workspace') ? '正在打开…' : '打开工作区'}</button>
          <button type="button" className="danger-button" disabled={disabled || !!busy} onClick={() => void act(run, 'abandon')}>{busy === action('abandon') ? '处理中…' : '放弃恢复'}</button>
        </div>
      </article>;
    })}
  </section>;
}
