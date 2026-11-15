import type { AgentTask, DeliveryPackageRecord, ImpactReport, JiraIssue, JiraWritebackRecord, ReviewRun, TaskEvidenceRecord, TaskPlan, TaskPlanStep, VerificationRunSummary } from './index';

export interface DeliveryRequest {
  projectId: string;
  sessionId?: string;
  taskId?: string;
  jiraKey?: string;
  implementationNotes?: string;
  remainingItems?: string;
}
export interface DeliverySnapshot {
  schemaVersion: 1;
  project: { id: string; name: string };
  taskId: string;
  sessionId?: string;
  goal: string;
  implementationNotes: string;
  remainingItems: string;
  jira?: JiraIssue;
  jiraWarning?: string;
  tasks: AgentTask[];
  plans: Array<{ plan: TaskPlan; steps: TaskPlanStep[] }>;
  git?: { workspacePath: string; branch: string; headSha: string; diffFingerprint: string; files: Array<{ path: string; status: string; layer?: string }>; truncated: boolean };
  gitWarning?: string;
  evidence: TaskEvidenceRecord[];
  verificationRuns: VerificationRunSummary[];
  impacts: ImpactReport[];
  reviews: ReviewRun[];
  capturedAt: string;
}
export interface DeliveryPreview { id: string; revision: number; snapshot: DeliverySnapshot; markdown: string; expiresAt: string }
export interface DeliveryWritebackPreview { record: JiraWritebackRecord; issue: { key: string; summary: string; status: string; updated?: string }; expiresAt: string }
export interface DeliveryApi {
  preview(input: DeliveryRequest): Promise<DeliveryPreview>;
  exportPackage(previewId: string): Promise<DeliveryPackageRecord | null>;
  listPackages(input: { projectId: string; taskId?: string }): Promise<DeliveryPackageRecord[]>;
  previewWriteback(input: { previewId: string; operation: 'comment' | 'attachment'; comment?: string; packageId?: string }): Promise<DeliveryWritebackPreview>;
  confirmWriteback(input: { recordId: string; requestHash: string; confirmed: true }): Promise<JiraWritebackRecord>;
  cancelWriteback(recordId: string): Promise<JiraWritebackRecord>;
  listWritebacks(jiraKey: string): Promise<JiraWritebackRecord[]>;
}
