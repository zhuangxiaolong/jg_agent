import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, IpcResult } from '../../../../packages/domain/src';
async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const result: IpcResult<unknown> = await ipcRenderer.invoke(channel, ...args);
  if (!result || typeof result.ok !== 'boolean') throw new Error('桌面通信响应无效，请重新启动应用');
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const api: DesktopApi = {
  bootstrap: () => invoke('app:bootstrap'),
  selectProject: () => invoke('project:select'),
  renameProject: (id, name) => invoke('project:rename', id, name),
  createSession: (id, jiraIssueKey, jiraProjectKey) => invoke('session:create', id, jiraIssueKey, jiraProjectKey),
  renameSession: (id, alias) => invoke('session:rename', id, alias),
  getEvents: id => invoke('session:events', id),
  sendTurn: (id, prompt) => invoke('session:send', id, prompt),
  cancelRun: id => invoke('session:cancel', id),
  getDiff: id => invoke('session:diff', id),
  configureSession: (id, input) => invoke('session:configure', id, input),
  getSettings: () => invoke('settings:get'),
  savePreferences: input => invoke('settings:preferences', input),
  saveLayout: input => invoke('settings:layout', input),
  saveModelProvider: input => invoke('settings:provider-save', input),
  deleteModelProvider: id => invoke('settings:provider-delete', id),
  saveJira: input => invoke('settings:jira', input),
  saveRequirement: input => invoke('settings:requirement-save', input),
  testJiraConnection: () => invoke('jira:test'),
  listJiraProjects: () => invoke('jira:projects'),
  searchJiraIssues: input => invoke('jira:search', input),
  listJiraQueries: () => invoke('jira:history'),
  getJiraIssue: (key, projectKey) => invoke('jira:issue', key, projectKey),
  getJiraImage: (key, attachmentId, sessionId) => invoke('jira:image', key, attachmentId, sessionId),
  importDocument: input => invoke('settings:document-import', input),
  deleteDocument: id => invoke('settings:document-delete', id),
  setDocumentEnabled: (id, enabled) => invoke('settings:document-enabled', id, enabled),
  saveMemory: input => invoke('settings:memory-save', input),
  deleteMemory: id => invoke('settings:memory-delete', id),
  getGitState: id => invoke('git:state', id),
  generateCommitMessage: id => invoke('git:message', id),
  checkRequirements: id => invoke('requirements:check', id),
  commitChanges: (id, input) => invoke('git:commit', id, input),
  pushChanges: (id, remote) => invoke('git:push', id, remote),
  pullChanges: (id, remote) => invoke('git:pull', id, remote),
  saveProvider: input => invoke('provider:save', input),
  backup: () => invoke('app:backup'),
  onEvent: listener => { const callback = (_event: unknown, value: Parameters<typeof listener>[0]) => listener(value); ipcRenderer.on('agent:event', callback); return () => { ipcRenderer.removeListener('agent:event', callback); }; }
};
contextBridge.exposeInMainWorld('jinggong', Object.freeze(api));
