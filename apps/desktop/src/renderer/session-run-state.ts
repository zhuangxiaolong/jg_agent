/**
 * 只有当前进程确实持有运行任务时才锁定会话输入框。
 * 持久化的 session.status 可能来自上次异常退出，不能单独代表当前仍在运行。
 */
export function isSessionRunActive(sessionId: string, activeSessionIds: ReadonlySet<string>, sending: boolean): boolean {
  return Boolean(sessionId && (sending || activeSessionIds.has(sessionId)));
}
