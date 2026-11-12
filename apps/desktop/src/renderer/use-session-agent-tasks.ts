import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentTask, AgentTaskEvent, DesktopApi } from '../../../../packages/domain/src';
import { agentTasksForSession } from './agent-task-state';

interface SessionAgentTaskState { sessionId: string; tasks: AgentTask[]; events: AgentTaskEvent[] }

/** 任务发现和实时日志共用一次订阅，空会话无需挂载子 Agent 面板。 */
export function useSessionAgentTasks(api: DesktopApi, sessionId: string, onError: (text: string) => void) {
  const [state, setState] = useState<SessionAgentTaskState>({ sessionId: '', tasks: [], events: [] });
  const activeSession = useRef('');
  const refreshVersion = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const refreshTasks = useCallback(async () => {
    if (!api || !sessionId || activeSession.current !== sessionId) return;
    const version = ++refreshVersion.current;
    const tasks = agentTasksForSession(await api.listAgentTasks(sessionId), sessionId);
    if (activeSession.current !== sessionId || version !== refreshVersion.current) return;
    setState(current => ({ sessionId, tasks, events: current.sessionId === sessionId ? current.events : [] }));
  }, [api, sessionId]);

  useEffect(() => {
    if (!api || !sessionId) return;
    activeSession.current = sessionId;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const report = (error: unknown) => {
      if (activeSession.current === sessionId) onErrorRef.current(error instanceof Error ? error.message : String(error));
    };
    const unsubscribe = api.onAgentTaskEvent(event => {
      if (activeSession.current !== sessionId || event.sessionId !== sessionId) return;
      setState(current => {
        const previous = current.sessionId === sessionId ? current : { sessionId, tasks: [], events: [] };
        return previous.events.some(item => item.id === event.id) ? previous : { ...previous, events: [...previous.events, event].slice(-500) };
      });
      // 合并流式输出，任务标签和详情不重复向主进程拉取同一列表。
      if (!refreshTimer) refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refreshTasks().catch(report);
      }, 150);
    });
    void refreshTasks().catch(report);
    return () => {
      activeSession.current = '';
      refreshVersion.current++;
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [api, sessionId, refreshTasks]);

  return {
    tasks: state.sessionId === sessionId ? agentTasksForSession(state.tasks, sessionId) : [],
    events: state.sessionId === sessionId ? state.events : [],
    refreshTasks,
  };
}
