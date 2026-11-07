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
  copyText: text => invoke('clipboard:write', text),
  openBrowser: (id, url) => invoke('browser:open', id, url),
  exportShare: input => invoke('share:export', input),
  importShare: projectId => invoke('share:import', projectId),
  saveRequirementsSync: input => invoke('requirements:sync-settings', input),
  syncRequirements: () => invoke('requirements:sync'),
  selectProject: () => invoke('project:select'),
  renameProject: (id, name) => invoke('project:rename', id, name),
  setProjectCollapsed: (id, collapsed) => invoke('project:collapse', id, collapsed),
  deleteProject: id => invoke('project:delete', id),
  createSession: (id, jiraIssueKey, jiraProjectKey, baseBranch) => invoke('session:create', id, jiraIssueKey, jiraProjectKey, baseBranch),
  listProjectBranches: id => invoke('project:branches', id),
  switchSessionBranch: (id, baseBranch) => invoke('session:branch', id, baseBranch),
  renameSession: (id, alias) => invoke('session:rename', id, alias),
  deleteSession: id => invoke('session:delete', id),
  markSessionRead: (id, completionId) => invoke('session:read', id, completionId),
  getEvents: id => invoke('session:events', id),
  sendTurn: (id, prompt, attachmentIds) => invoke('session:send', id, { prompt, attachmentIds: attachmentIds ?? [] }),
  pickAttachments: id => invoke('session:pick-attachments', id),
  cancelRun: id => invoke('session:cancel', id),
  getDiff: id => invoke('session:diff', id),
  getFileDiff: (id, file) => invoke('session:file-diff', id, file),
  configureSession: (id, input) => invoke('session:configure', id, input),
  getSettings: () => invoke('settings:get'),
  savePreferences: input => invoke('settings:preferences', input),
  saveLayout: input => invoke('settings:layout', input),
  notifyCompletion: title => invoke('notification:complete', title),
  installUpdate: () => invoke('app:update-install'),
  checkForUpdate: () => invoke('app:update-check'),
  downloadUpdate: () => invoke('app:update-download'),
  saveUpdateUrl: url => invoke('settings:update-url', url),
  onUpdateStatus: listener => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) => listener(status);
    ipcRenderer.on('app:update-status', wrapped);
    return () => ipcRenderer.removeListener('app:update-status', wrapped);
  },
  saveModelProvider: input => invoke('settings:provider-save', input),
  deleteModelProvider: id => invoke('settings:provider-delete', id),
  saveJira: input => invoke('settings:jira', input),
  saveRequirement: input => invoke('settings:requirement-save', input),
  testJiraConnection: () => invoke('jira:test'),
  listJiraProjects: () => invoke('jira:projects'),
  searchJiraIssues: input => invoke('jira:search', input),
  listJiraQueries: () => invoke('jira:history'),
  getJiraIssue: (key, projectKey) => invoke('jira:issue', key, projectKey),
  getJiraWorkflow: (key, projectKey) => invoke('jira:workflow', key, projectKey),
  searchJiraAssignees: (key, query, projectKey) => invoke('jira:assignees', key, query, projectKey),
  selectJiraTestImages: () => invoke('jira:test-images'),
  transitionJira: input => invoke('jira:transition', input),
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
  stageFile: (id, file) => invoke('git:file-stage', id, file),
  unstageFile: (id, file) => invoke('git:file-unstage', id, file),
  discardFile: (id, file) => invoke('git:file-discard', id, file),
  openChangedFile: (id, file) => invoke('git:file-open', id, file),
  saveProvider: input => invoke('provider:save', input),
  backup: () => invoke('app:backup'),
  onEvent: listener => { const callback = (_event: unknown, value: Parameters<typeof listener>[0]) => listener(value); ipcRenderer.on('agent:event', callback); return () => { ipcRenderer.removeListener('agent:event', callback); }; }
};
contextBridge.exposeInMainWorld('jinggong', Object.freeze(api));
