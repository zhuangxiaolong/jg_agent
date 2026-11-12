import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/** 操作提示自动消失；重复的同文提示也从本次触发重新计时。 */
export function useTransientError(durationMs = 3000): [string, Dispatch<SetStateAction<string>>] {
  const [state, setState] = useState({ text: '', version: 0 });
  const setError = useCallback<Dispatch<SetStateAction<string>>>(value => {
    setState(previous => ({ text: typeof value === 'function' ? value(previous.text) : value, version: previous.version + 1 }));
  }, []);
  useEffect(() => {
    if (!state.text) return;
    const timer = window.setTimeout(() => setState(previous => previous.version === state.version ? { text: '', version: previous.version } : previous), durationMs);
    return () => window.clearTimeout(timer);
  }, [state.text, state.version, durationMs]);
  return [state.text, setError];
}
