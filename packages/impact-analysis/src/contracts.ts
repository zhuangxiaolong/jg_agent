import type { ImpactReport, ReviewFinding } from '../../domain/src';
import type { ImpactAnalysisReport } from './index';

export interface ImpactReviewTarget { projectId: string; sessionId?: string }
export interface ImpactReviewRecord extends ImpactReport {
  kind: 'static-impact-v1';
  target: ImpactReviewTarget;
  analysis: ImpactAnalysisReport;
  reviewRunId: string;
  scopeDescription: string;
  limitations: string[];
  staleReason?: string;
}
export interface ManagedReviewFinding extends ReviewFinding {
  source: string;
  suggestion: string;
  correlation: 'new' | 'persisting' | 'unverifiable';
  previousFindingId?: string;
  dispositionReason?: string;
  updatedAt: string;
}
export interface ImpactReviewDetail { report: ImpactReviewRecord; findings: ManagedReviewFinding[] }
export type FindingDisposition = 'confirmed' | 'ignored' | 'false_positive';
export interface ImpactReviewApi {
  list(target: ImpactReviewTarget): Promise<ImpactReviewRecord[]>;
  analyze(target: ImpactReviewTarget): Promise<ImpactReviewDetail>;
  detail(input: { projectId: string; reportId: string }): Promise<ImpactReviewDetail>;
  updateFinding(input: { projectId: string; reportId: string; findingId: string; status: FindingDisposition; reason?: string }): Promise<ImpactReviewDetail>;
  exportReport(input: { projectId: string; reportId: string }): Promise<{ cancelled: boolean; path?: string }>;
}
