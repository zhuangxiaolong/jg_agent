import type { RuntimeKind, Session } from './index';

export type ExpertProduct = 'MES5' | 'MES6' | 'WMS';
export type ExpertRole = 'requirements_analyst' | 'backend_developer' | 'frontend_developer' | 'fullstack_developer' | 'test_quality' | 'project_director' | 'project_manager' | 'implementation_engineer';
export interface ExpertProfile {
  id: string; name: string; familyId: string; role?: ExpertRole; builtin: boolean;
  version: number; contentHash: string; enabled: boolean; isDefault: boolean;
  workflowId: string; steps: string[]; sources: string[]; skillTags: string[]; output: string; checks: string;
}
export type ExpertScope = NonNullable<Session['manualKnowledgeScope']>;
export interface ExpertSelection { profileId: string; scope: ExpertScope }
export interface ExpertSource { kind: string; id: string; label: string; hash: string; version?: string }
export interface ExpertRun {
  id: string; sessionId: string; createdAt: string; router: string; routerHash: string; profileId: string; name: string; version: number; hash: string;
  workflowId: string; reason: string; scope: string[]; runtime: RuntimeKind; model: string; provider?: string; sources: ExpertSource[];
  status: 'running' | 'completed' | 'failed' | 'interrupted'; error?: string; feedback?: ExpertFeedback;
}
export interface ExpertFeedback { rating: '有帮助' | '无帮助' | '不准确'; reason?: string }
export interface ExpertCase { id: string; product: ExpertProduct; profileId: string; prompt: string; expected: string; reference: string }
export interface ExpertGrade { scores: number[]; citation: '正确' | '错误' | '不适用'; mismatch: boolean; complete: boolean; notes: string }
export interface EvalArm { status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted'; answer?: string; error?: string; grade?: ExpertGrade }
export interface ExpertComparison {
  id: string; createdAt: string; case: ExpertCase; runtime: RuntimeKind; provider: string; model: string; effort?: string;
  inputHash: string; contextHash: string; strategy: string; profileId: string; profileHash: string; profileVersion: number; sources: ExpertSource[];
  baseline: EvalArm; expert: EvalArm;
}
export interface ExpertApi {
  profiles(): Promise<ExpertProfile[]>;
  session(id: string): Promise<{ selection: ExpertSelection; runs: ExpertRun[] }>;
  select(id: string, selection: ExpertSelection): Promise<void>;
  profile(action: 'copy' | 'edit' | 'toggle' | 'default' | 'restore' | 'delete', id: string, patch?: { name: string; output: string; steps: string[]; version: number }): Promise<ExpertProfile[]>;
  feedback(sessionId: string, runId: string, value: ExpertFeedback): Promise<void>;
  cases(): Promise<ExpertCase[]>; saveCase(value: ExpertCase): Promise<void>; deleteCase(id: string): Promise<void>;
  comparisons(): Promise<ExpertComparison[]>;
  compare(sessionId: string, caseId: string, profileId: string): Promise<void>; stop(): Promise<void>;
  grade(id: string, arm: 'baseline' | 'expert', grade: ExpertGrade): Promise<void>;
  export(format: 'json' | 'md'): Promise<void>;
}
