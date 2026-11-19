import type { RuntimeKind } from './index';

export type LearningCandidateStatus = 'draft' | 'needs_review' | 'approved' | 'published' | 'rejected' | 'superseded';
export type LearningEvidenceKind = 'task_contract' | 'task_evidence' | 'skill_usage';
export type LearningFeedback = 'helpful' | 'not_helpful' | 'incorrect';
export interface LearningEvidenceRef { kind: LearningEvidenceKind; refId: string; contentHash?: string; contractVersion?: number; status?: string }
export interface LearningSafetyFinding { code: string; severity: 'warning' | 'block'; message: string; position: number }
export interface LearningCandidate {
  id: string; revision: number; sessionId: string; taskId: string; taskType: string;
  evidenceLevel: 'verified' | 'review_only' | 'failure_lesson'; status: LearningCandidateStatus;
  title: string; suggestedSkillName: string; description: string;
  systemScope: Array<'MES5' | 'MES6' | 'WMS' | 'GENERAL'>; sourceTaskIds: string[];
  evidence: LearningEvidenceRef[]; draftSkillMarkdown: string; generationMethod: 'local' | 'user_edited' | 'ai';
  safetyFindings: LearningSafetyFinding[]; createdAt: string; updatedAt: string;
  publishedPluginId?: string; publishedSkillId?: string; publishedVersion?: string; publishedHash?: string;
}
export interface LearningEligibility {
  eligible: boolean; candidateTypes: Array<'skill' | 'failure_lesson'>;
  blockReasons: string[]; warnings: string[]; requiresManualConfirmation: boolean; evidenceRefs: LearningEvidenceRef[];
}
export interface LearningValidationResult { valid: boolean; findings: LearningSafetyFinding[]; contentHash: string }
export interface LearningUsageRecord {
  eventId: string; sessionId: string; turnId: string; skillId: string; pluginId: string;
  runtimeKind: RuntimeKind; pluginVersion: string; pluginHash: string; skillHash: string;
  eventType: string; selectionSource: string; createdAt: string; feedback?: LearningFeedback;
}
export interface LearningAiProvider { id: string; name: string; models: string[] }
export interface LearningEngineApi {
  eligibility(sessionId: string, taskId: string): Promise<LearningEligibility>;
  listCandidates(sessionId?: string): Promise<LearningCandidate[]>;
  createCandidate(input: { sessionId: string; taskId: string; candidateType: 'skill' | 'failure_lesson'; selectedEvidenceIds: string[]; manualConfirmation: boolean }): Promise<LearningCandidate>;
  updateCandidate(input: { candidateId: string; expectedRevision: number; title: string; suggestedSkillName: string; description: string; draftSkillMarkdown: string; systemScope: LearningCandidate['systemScope'] }): Promise<LearningCandidate>;
  listAiProviders(): Promise<LearningAiProvider[]>;
  generateAiDraft(input: { candidateId: string; expectedRevision: number; providerId: string; model: string; selectedEvidenceIds: string[]; selectedExcerpt?: string }): Promise<LearningCandidate>;
  validateCandidate(candidateId: string): Promise<LearningValidationResult>;
  approveCandidate(input: { candidateId: string; expectedRevision: number }): Promise<LearningCandidate>;
  publishCandidate(input: { candidateId: string; expectedRevision: number; scope: 'disabled' | 'project' }): Promise<LearningCandidate>;
  rejectCandidate(input: { candidateId: string; expectedRevision: number }): Promise<LearningCandidate>;
  listUsage(sessionId: string): Promise<LearningUsageRecord[]>;
  submitFeedback(input: { eventId: string; feedback: LearningFeedback }): Promise<void>;
}
