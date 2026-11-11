import type { AgentEvent, Session } from '../../../../packages/domain/src';

export function sessionDisplayName(session: Pick<Session, 'title' | 'alias' | 'jiraIssue'>): string {
  if (session.alias !== undefined) return session.alias;
  if (session.jiraIssue) {
    const summary = session.jiraIssue.summary.replace(/\s+/g, ' ').trim();
    return summary ? `${session.jiraIssue.key} · ${summary}` : session.jiraIssue.key;
  }
  return session.title.replace(/\s*·\s*(?:隔离开发|代码开发|只读分析)$/, '');
}

/** 仅用于平台提示的显示名称；保留路径、URL、代码片段及底层原始数据。 */
export function engineText(value = '') {
  return value.replace(/仅允许读取应用管理的隔离工作区。?/g, '当前会话工作区不可用，请新建会话后重试。').split(/((?:[A-Za-z]:[\\/]|\\\\|https?:\/\/)[^\r\n"<>，。；：]*|```[\s\S]*?```|`[^`]*`)/g)
    .map((part, index) => index % 2 ? part : part.replace(/(?<![\\/A-Za-z0-9_.-])Codex(?: Runtime)?(?![\\/A-Za-z0-9_.-])/gi, '精工Agent引擎').replace(/(?<![\\/A-Za-z0-9_.-])Runtime(?![\\/A-Za-z0-9_.-])/g, '引擎'))
    .join('');
}
export function engineVersion(value = '') { return value.replace(/^codex(?:[- ]cli)?\s*/i, ''); }
export function toolPlatformText(value: string) {
  // Git 事件包含用户提交说明和真实分支信息，原样展示这些业务内容。
  return /^(?:已提交|已推送)\s/.test(value) ? value : engineText(value);
}

function shortText(value: string, maximum = 180): string {
  const firstLine = value.replace(/\s+/g, ' ').trim();
  return firstLine.length > maximum ? `${firstLine.slice(0, maximum - 1)}…` : firstLine;
}

/** 把 Runtime 内部工具日志转换成会话中可读的一行进度。返回 null 表示内部噪声。 */
export function compactToolEvent(value: string): string | null {
  const text = value.trim();
  if (!text || text === '已按完整开发配置允许当前任务执行。' || /^未处理运行时请求：/.test(text)) return null;
  if (/^执行命令：/.test(text) && !text.includes('退出码：')) return null;
  const command = /^命令执行完成：([\s\S]*?)(?:\n退出码：([^\n]*))?(?:\n[\s\S]*)?$/.exec(text);
  if (command) {
    const code = command[2]?.trim();
    return code && code !== '0' && code !== '未知' ? `命令执行失败（退出码 ${shortText(code, 30)}）：${shortText(command[1])}` : `命令已完成：${shortText(command[1])}`;
  }
  const project = /^已执行项目文件工具 ([^：]+)：(.*?)(?:\s+SHA256=[a-f0-9]+)?$/i.exec(text);
  if (project) {
    const labels: Record<string, string> = { list_project_files: '读取项目文件列表', read_project_file: '读取项目文件', write_project_file: '修改项目文件', delete_project_file: '删除项目文件' };
    return `${labels[project[1]] ?? '执行项目工具'}：${shortText(project[2])}`;
  }
  const dictionary = /^已执行字典工具 ([^：]+)：(.+?)(?:\s+SHA256=[a-f0-9]+)?$/i.exec(text);
  if (dictionary) return `${dictionary[1] === 'search_dictionary' ? '检索数据字典' : '读取数据字典'}：${shortText(dictionary[2])}`;
  const rejected = /^已拒绝项目或字典访问：/.test(text);
  if (rejected) return `工具访问未完成：${shortText(text.replace(/^已拒绝项目或字典访问：/, ''))}`;
  if (/^已操作内置浏览器：/.test(text)) return shortText(text);
  if (/^已发布(?:初步)?代码修改方案：/.test(text)) return shortText(text);
  // 未知工具保留一行摘要，避免渲染协议详情和多行命令输出。
  return shortText(text);
}

export function compactAgentEvent(event: Pick<AgentEvent, 'type' | 'text'>): string | null {
  if (event.type === 'tool' || event.type === 'approval') {
    const compact = compactToolEvent(event.text);
    if (compact && event.type === 'tool' && /^(?:读取项目文件列表|读取项目文件|检索数据字典|读取数据字典)：/.test(compact)) return null;
    // 未知协议事件通常是 Runtime 的内部生命周期日志，不放进主会话时间线。
    if (compact && event.type === 'tool' && !/^(?:命令已完成|命令执行失败|修改项目文件|删除项目文件|工具访问未完成|已操作内置浏览器|已发布(?:初步)?代码修改方案)：/.test(compact)) return null;
    return compact;
  }
  if (event.type === 'status' && /^(?:工具链已更新|仅允许读取应用管理的隔离工作区)/.test(event.text)) return null;
  return event.text;
}
