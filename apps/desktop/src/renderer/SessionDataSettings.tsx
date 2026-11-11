import { useEffect, useState } from 'react';
import type { DesktopApi, Project, Session, ShareImportResult } from '../../../../packages/domain/src';
import { Icon } from './ui';
import { sessionDisplayName } from './branding';

export function SessionDataSettings({ sessions, projects, currentProjectId, onImportCompleted, pending, act, api }: {
  sessions: Session[];
  projects: Project[];
  currentProjectId?: string;
  onImportCompleted?: (sessionId?: string) => Promise<void>;
  pending: boolean;
  act: (work: () => Promise<unknown>, success?: string | (() => string)) => Promise<boolean>;
  api: DesktopApi;
}) {
  const [sessionId, setSessionId] = useState('');
  const [projectId, setProjectId] = useState('');
  const session = sessions.find(item => item.id === sessionId);
  useEffect(() => {
    setSessionId(current => sessions.some(item => item.id === current) ? current : sessions[0]?.id || '');
  }, [sessions]);
  useEffect(() => {
    setProjectId(current => projects.some(item => item.id === current) ? current : '');
  }, [projects]);

  async function importShare() {
    let result: ShareImportResult | null = null;
    await act(async () => {
      result = await api.importShare(projectId || undefined);
      if (result) await onImportCompleted?.(result.sessionId);
    }, () => result ? `已导入 ${result.sessions} 个会话、${result.memories} 条记忆。` : '已取消导入。');
  }

  async function exportSession() {
    let exportedPath: string | null = null;
    await act(async () => {
      exportedPath = await api.exportShare({ kind: 'session', sessionId });
    }, () => exportedPath ? `会话分享文件已导出至：${exportedPath}` : '已取消导出。');
  }

  async function backup() {
    let backupPath: string | null = null;
    await act(async () => {
      backupPath = await api.backup();
    }, () => backupPath ? `本地数据已备份至：${backupPath}` : '已取消备份。');
  }

  return <section aria-label="会话导入导出与本地数据备份">
    <div className="section-heading"><div><h3>会话与数据</h3><p>管理会话分享文件和本地数据备份。</p></div></div>
    <div className="settings-form">
      <h4>会话分享</h4>
      <label htmlFor="session-export-target">导出会话</label>
      <div className="document-controls">
        <select id="session-export-target" aria-label="选择要导出的会话" value={session?.id ?? ''} onChange={event => setSessionId(event.target.value)} disabled={pending || !sessions.length}>
          {!sessions.length && <option value="">暂无会话</option>}
          {sessions.map(item => <option key={item.id} value={item.id}>{sessionDisplayName(item)}</option>)}
        </select>
        <button className="secondary-button" type="button" disabled={pending || !session} onClick={() => void exportSession()}><Icon name="download" />导出所选会话</button>
      </div>
      <label htmlFor="session-import-project">导入会话（接收项目可选）</label>
      <div className="document-controls">
        <select id="session-import-project" aria-label="选择会话接收项目" value={projectId} onChange={event => setProjectId(event.target.value)} disabled={pending || !projects.length}>
          <option value="">不关联项目 · 导入为独立会话</option>
          {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button className="secondary-button" type="button" disabled={pending} onClick={() => void importShare()}><Icon name="download" />导入会话或记忆</button>
      </div>
      <p className="field-hint">可以直接导入为独立会话；需要处理代码时，再选择本机项目作为接收位置。</p>
    </div>
    <div className="settings-form">
      <h4>本地数据备份</h4>
      <p className="field-hint">备份会话数据库，不包含 API Key 等密钥，也不包含代码文件。</p>
      <div className="settings-actions"><button className="secondary-button" type="button" disabled={pending} onClick={() => void backup()}><Icon name="download" />导出会话备份</button></div>
    </div>
  </section>;
}
