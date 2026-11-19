import type { RuntimeKind } from './index';

export type SkillScope = 'disabled' | 'global' | 'project';
export type SkillCompatibilityStatus = 'Full' | 'Partial' | 'MetadataOnly' | 'Unsupported' | 'Invalid';
export type SkillUsageEventType = 'skill.recommended' | 'skill.selected' | 'skill.load_requested' | 'skill.loaded' | 'skill.load_failed' | 'skill.resource_read' | 'skill.skipped';
export type SkillSelectionSource = 'scope' | 'manual' | 'automatic';

export interface SkillScopeRecord { skillId: string; scope: SkillScope; projectId?: string; updatedAt: string }
export interface SessionSkillSnapshotEntry {
  skillId: string;
  pluginId: string;
  pluginVersion: string;
  pluginHash: string;
  skillHash: string;
  selectionSource: 'scope' | 'manual';
  scope: Exclude<SkillScope, 'disabled'>;
  projectId?: string;
}
export interface SkillUsageEvent {
  id: string;
  sessionId: string;
  turnId: string;
  skillId: string;
  pluginId: string;
  runtimeKind: RuntimeKind;
  eventType: SkillUsageEventType;
  pluginVersion: string;
  pluginHash: string;
  skillHash: string;
  selectionSource: SkillSelectionSource;
  detailRedacted?: { reason?: string; score?: number; resourcePath?: string; errorCode?: string };
  createdAt: string;
}

export function skillCompatibilityStatus(runtimeKind: RuntimeKind, skillEnabled: boolean, pluginEnabled: boolean, pluginTrusted: boolean, contentValid = true): SkillCompatibilityStatus {
  if (!contentValid) return 'Invalid';
  if (!skillEnabled || !pluginEnabled || !pluginTrusted) return 'Unsupported';
  if (runtimeKind === 'jinggong') return 'Full';
  if (runtimeKind === 'codex') return 'Partial';
  return 'MetadataOnly';
}
