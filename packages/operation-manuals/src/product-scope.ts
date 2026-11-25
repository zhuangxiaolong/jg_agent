import type { ManualProductType } from './index';

export function manualProductScope(override: 'auto' | ManualProductType | 'off' | undefined, detected?: string, query = ''): ManualProductType[] {
  if (override === 'off') return [];
  if (override && override !== 'auto') return [override, 'COMMON'];
  const mentioned = (['MES5', 'MES6', 'WMS', 'SRM', 'JMOM', 'PDA'] as const).filter(system => new RegExp(`(?:^|[^a-z0-9])${system}(?:$|[^a-z0-9])`, 'i').test(query));
  if (mentioned.length) return [...mentioned, 'COMMON'];
  if (/通用(?:产品)?(?:操作)?手册|通用操作说明/.test(query)) return ['COMMON'];
  return detected === 'MES5' || detected === 'MES6' || detected === 'WMS' ? [detected, 'COMMON'] : [];
}
