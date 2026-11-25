import type { DeliveryIssue, DeliveryProject } from './delivery-workbench';

export type DiagnosticProduct = 'MES5' | 'MES6' | 'WMS' | 'OTHER';
export type DiagnosticPriority = 'critical' | 'high' | 'medium' | 'low';
export type DiagnosticCaseStatus = 'new' | 'triaging' | 'awaiting_input' | 'diagnosing' | 'awaiting_customer' | 'awaiting_development' | 'pending_verification' | 'resolved' | 'closed' | 'reopened' | 'cancelled';
export type DiagnosticCategory = 'business' | 'configuration' | 'data' | 'permission' | 'integration' | 'defect' | 'performance' | 'environment' | 'operation' | 'other' | 'unknown';
export type DiagnosticStepStatus = 'pending' | 'in_progress' | 'confirmed_normal' | 'confirmed_abnormal' | 'inconclusive' | 'not_applicable' | 'blocked';
export type DiagnosticSafetyLevel = 'read_only_ui' | 'read_only_evidence' | 'manual_customer_action';
export type DiagnosticRunKind = 'triage' | 'plan' | 'replan' | 'root_cause';
export type DiagnosticRunStatus = 'running' | 'succeeded' | 'stale' | 'failed' | 'cancelled';
export type DiagnosticKnowledgeStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'archived';

export interface DiagnosticSourceRef {
  sourceType: 'manual' | 'project_document' | 'approved_case' | 'diagnostic_evidence' | 'diagnostic_step' | 'user_input' | 'generic_knowledge';
  sourceId: string;
  sourceName: string;
  locator?: string;
  quote?: string;
  productVersion?: string;
}

export interface DiagnosticKnownFact { text: string; sourceRefs: string[] }
export interface DiagnosticMissingInformation { question: string; whyItMatters: string; priority: 'high' | 'medium' | 'low' }

export interface DiagnosticTriage {
  summary: string;
  product: DiagnosticProduct | 'unknown';
  productVersion?: string;
  module: string;
  businessProcess: string;
  issueCategory: DiagnosticCategory;
  prioritySuggestion: DiagnosticPriority | 'unknown';
  impactScopeSuggestion?: string;
  knownFacts: DiagnosticKnownFact[];
  missingInformation: DiagnosticMissingInformation[];
  hypotheses: Array<Pick<DiagnosticHypothesis, 'title' | 'category' | 'confidence' | 'supportingRefs' | 'contradictingRefs' | 'nextVerification'>>;
  immediateSafetyNote?: string;
}

export interface DiagnosticCase {
  id: string;
  code: string;
  title: string;
  symptom: string;
  expectedResult?: string;
  actualResult?: string;
  reproduceSteps?: string;
  product: DiagnosticProduct;
  productVersion?: string;
  module?: string;
  businessProcess?: string;
  issueCategory: DiagnosticCategory;
  priority: DiagnosticPriority;
  status: DiagnosticCaseStatus;
  occurredAt?: string;
  frequency?: string;
  impactScope?: string;
  environment?: string;
  deliveryProjectId?: string;
  deliveryIssueId?: string;
  assigneeLabel?: string;
  reporterLabel?: string;
  currentRunId?: string;
  triage?: DiagnosticTriage;
  planRevision: number;
  resolutionSummary?: string;
  createdAt: string;
  updatedAt: string;
  statusChangedAt?: string;
  closedAt?: string;
}

export type DiagnosticTriageConfirmation = Partial<Pick<DiagnosticCase,
  'product' | 'productVersion' | 'module' | 'businessProcess' | 'issueCategory' | 'priority' | 'impactScope'>>;

export interface DiagnosticRun {
  id: string;
  caseId: string;
  revision: number;
  kind: DiagnosticRunKind;
  status: DiagnosticRunStatus;
  runtimeKind?: 'codex' | 'jinggong';
  model?: string;
  promptVersion: string;
  inputSnapshotHash: string;
  outputHash?: string;
  outputJson?: string;
  errorSummary?: string;
  sourceRefs: DiagnosticSourceRef[];
  startedAt: string;
  completedAt?: string;
}

export interface DiagnosticStep {
  id: string;
  caseId: string;
  runId: string;
  planRevision: number;
  order: number;
  title: string;
  purpose: string;
  hypothesis?: string;
  instructions: string;
  preconditions: string[];
  expectedNormal: string;
  abnormalSignals: string[];
  requestedEvidence: string[];
  sourceRefs: string[];
  nextBranches: Array<{ when: string; nextAction: string }>;
  safetyLevel: DiagnosticSafetyLevel;
  status: DiagnosticStepStatus;
  resultText?: string;
  resultBy?: string;
  resultAt?: string;
  evidenceIds: string[];
  blockedReason?: string;
  notApplicableReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiagnosticEvidence {
  id: string;
  caseId: string;
  kind: 'screenshot' | 'log' | 'text' | 'document' | 'api_request' | 'api_response' | 'database_result' | 'other';
  originalName: string;
  storageKey: string;
  redactedStorageKey?: string;
  extension: string;
  mimeType?: string;
  size: number;
  sha256: string;
  status: 'stored' | 'parsed' | 'parse_failed' | 'redacted' | 'deleted';
  parseSummary?: string;
  redactionSummary?: string;
  sourceLabel?: string;
  createdAt: string;
  deletedAt?: string;
}

export interface DiagnosticHypothesis {
  id: string;
  caseId: string;
  runId: string;
  title: string;
  category: string;
  confidence: 'high' | 'medium' | 'low';
  status: 'suspected' | 'under_verification' | 'verified_by_engineer' | 'rejected' | 'unknown';
  supportingRefs: string[];
  contradictingRefs: string[];
  nextVerification?: string;
  confirmedBy?: string;
  confirmedAt?: string;
}

export interface DiagnosticResolution {
  id: string;
  caseId: string;
  rootCauseSummary: string;
  rootCauseStatus: 'suspected' | 'verified_by_engineer' | 'unknown';
  rootCauseUnknownReason?: string;
  resolutionType: 'workaround' | 'permanent_fix' | 'prevention' | 'development_required' | 'customer_or_vendor_action';
  actionSummary: string;
  verificationMethod: string;
  verificationResult: 'passed' | 'failed' | 'partial' | 'not_run';
  verificationNotes?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  acceptedUnverifiedRisk?: boolean;
  acceptedRiskReason?: string;
  createdAt: string;
}

export interface DiagnosticKnowledgeCase {
  id: string;
  sourceCaseId: string;
  title: string;
  product: DiagnosticProduct;
  productVersionRange?: string;
  module?: string;
  symptom: string;
  diagnosisPath: string;
  rootCause: string;
  resolution: string;
  verification: string;
  constraints: string[];
  anonymizedContentHash: string;
  status: DiagnosticKnowledgeStatus;
  sharedAcrossProjects: boolean;
  reviewerLabel?: string;
  reviewNote?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiagnosticEvent {
  id: string;
  caseId: string;
  eventType: string;
  summary: string;
  createdAt: string;
}

export interface DiagnosticCaseDetails {
  case: DiagnosticCase;
  runs: DiagnosticRun[];
  steps: DiagnosticStep[];
  evidence: DiagnosticEvidence[];
  hypotheses: DiagnosticHypothesis[];
  resolutions: DiagnosticResolution[];
  events: DiagnosticEvent[];
  knowledgeCases: DiagnosticKnowledgeCase[];
}

export interface DiagnosticOverview {
  total: number;
  open: number;
  criticalOrHigh: number;
  awaitingCustomer: number;
  awaitingDevelopment: number;
  pendingVerification: number;
  recent: DiagnosticCase[];
  recentClosed: DiagnosticCase[];
  knowledgeReview: number;
  projects: Array<{
    projectId: string;
    project: DeliveryProject;
    total: number;
    open: number;
    criticalOrHigh: number;
    awaitingCustomer: number;
    awaitingDevelopment: number;
    pendingVerification: number;
    unassigned: number;
    reopened: number;
    lastUpdatedAt?: string;
    cases: DiagnosticCase[];
  }>;
}

export interface DiagnosticAnalysisPreview {
  task: DiagnosticRunKind;
  runtimeKind: 'codex' | 'jinggong';
  model: string;
  inputSnapshotHash: string;
  sources: Array<{ id: string; name: string; preview: string }>;
  warnings: string[];
}

export interface DiagnosticListInput {
  query?: string;
  status?: DiagnosticCaseStatus | 'all';
  product?: DiagnosticProduct | 'all';
  priority?: DiagnosticPriority | 'all';
  issueCategory?: DiagnosticCategory | 'all';
  module?: string;
  assigneeLabel?: string;
  reporterLabel?: string;
  deliveryProjectId?: string;
  sortBy?: 'updated' | 'priority';
  offset?: number;
  limit?: number;
}

export interface DiagnosticCreateCaseInput {
  title: string;
  symptom: string;
  expectedResult?: string;
  actualResult?: string;
  reproduceSteps?: string;
  product: DiagnosticProduct;
  productVersion?: string;
  module?: string;
  businessProcess?: string;
  issueCategory?: DiagnosticCategory;
  priority: DiagnosticPriority;
  occurredAt?: string;
  frequency?: string;
  impactScope?: string;
  environment?: string;
  deliveryProjectId: string;
  deliveryIssueId?: string;
  assigneeLabel?: string;
  reporterLabel?: string;
}

export interface DiagnosticCasePatch {
  title?: string;
  symptom?: string;
  expectedResult?: string;
  actualResult?: string;
  reproduceSteps?: string;
  product?: DiagnosticProduct;
  productVersion?: string;
  module?: string;
  businessProcess?: string;
  issueCategory?: DiagnosticCategory;
  priority?: DiagnosticPriority;
  occurredAt?: string;
  frequency?: string;
  impactScope?: string;
  environment?: string;
  deliveryProjectId?: string | null;
  deliveryIssueId?: string | null;
  assigneeLabel?: string;
  reporterLabel?: string;
  resolutionSummary?: string;
}

export interface DiagnosticApi {
  overview(): Promise<DiagnosticOverview>;
  listCases(input: DiagnosticListInput): Promise<DiagnosticCase[]>;
  getCase(id: string): Promise<DiagnosticCaseDetails>;
  createCase(input: DiagnosticCreateCaseInput): Promise<DiagnosticCase>;
  importDeliveryIssue(projectId: string, issueId: string): Promise<{ item: DiagnosticCase; created: boolean }>;
  updateCase(id: string, patch: DiagnosticCasePatch): Promise<DiagnosticCase>;
  applyTriage(id: string, input: DiagnosticTriageConfirmation): Promise<DiagnosticCaseDetails>;
  transitionCase(id: string, status: DiagnosticCaseStatus, reason?: string): Promise<DiagnosticCase>;
  previewAnalysis(id: string, task: DiagnosticRunKind): Promise<DiagnosticAnalysisPreview>;
  selectEvidence(id: string): Promise<DiagnosticEvidence[]>;
  readEvidencePreview(id: string, evidenceId: string): Promise<string>;
  deleteEvidence(id: string, evidenceId: string): Promise<DiagnosticCaseDetails>;
  runAnalysis(id: string, task: DiagnosticRunKind, previewHash: string): Promise<DiagnosticCaseDetails>;
  cancelAnalysis(): Promise<void>;
  submitStepResult(id: string, stepId: string, input: { status: DiagnosticStepStatus; resultText?: string; resultBy?: string; evidenceIds?: string[]; reason?: string }): Promise<DiagnosticCaseDetails>;
  updateHypothesis(id: string, hypothesisId: string, input: { status: DiagnosticHypothesis['status']; confirmedBy?: string }): Promise<DiagnosticCaseDetails>;
  saveResolution(id: string, input: Omit<DiagnosticResolution, 'id' | 'caseId' | 'createdAt'>): Promise<DiagnosticCaseDetails>;
  exportDeveloperDraft(id: string): Promise<string | null>;
  prepareKnowledgeCase(id: string): Promise<DiagnosticCaseDetails>;
  submitKnowledgeCase(id: string, knowledgeCaseId: string, input: { sharedAcrossProjects: boolean }): Promise<DiagnosticCaseDetails>;
  reviewKnowledgeCase(id: string, knowledgeCaseId: string, input: { status: 'approved' | 'rejected'; reviewerLabel: string; reviewNote: string }): Promise<DiagnosticCaseDetails>;
  searchKnowledgeCases(input: { product: DiagnosticProduct; query: string; deliveryProjectId?: string }): Promise<DiagnosticKnowledgeCase[]>;
  exportCase(id: string): Promise<string>;
  saveDraftFile(id: string, markdown: string): Promise<string | null>;
  listProjects(): Promise<Array<DeliveryProject & { issues: DeliveryIssue[] }>>;
}

export function saveDiagnosticTriageProposal(item: DiagnosticCase, triage: DiagnosticTriage, status: DiagnosticCaseStatus, currentRunId: string, updatedAt: string): DiagnosticCase {
  return { ...item, triage, status, currentRunId, updatedAt };
}

export function applyDiagnosticTriage(item: DiagnosticCase, confirmation: DiagnosticTriageConfirmation, updatedAt: string): DiagnosticCase {
  return { ...item, ...confirmation, updatedAt };
}

export function canTransitionDiagnosticCase(from: DiagnosticCaseStatus, to: DiagnosticCaseStatus): boolean {
  const transitions: Record<DiagnosticCaseStatus, DiagnosticCaseStatus[]> = {
    new: ['triaging', 'cancelled'],
    triaging: ['awaiting_input', 'diagnosing', 'new', 'cancelled'],
    awaiting_input: ['triaging', 'diagnosing', 'cancelled', 'reopened'],
    diagnosing: ['awaiting_input', 'awaiting_customer', 'awaiting_development', 'pending_verification', 'resolved', 'cancelled', 'reopened'],
    awaiting_customer: ['diagnosing', 'pending_verification', 'cancelled', 'reopened'],
    awaiting_development: ['diagnosing', 'pending_verification', 'cancelled', 'reopened'],
    pending_verification: ['resolved', 'diagnosing', 'reopened', 'cancelled'],
    resolved: ['closed', 'reopened', 'diagnosing'],
    closed: ['reopened'],
    reopened: ['triaging', 'diagnosing', 'cancelled'],
    cancelled: ['reopened'],
  };
  return transitions[from].includes(to);
}

export function canCloseDiagnosticResolution(resolution: DiagnosticResolution): boolean {
  if (!resolution.actionSummary.trim() || !resolution.verificationMethod.trim() || !resolution.verifiedBy?.trim()) return false;
  if (resolution.rootCauseStatus === 'unknown' && !resolution.rootCauseUnknownReason?.trim()) return false;
  if (resolution.verificationResult === 'passed') return !!resolution.verifiedAt;
  return resolution.verificationResult === 'not_run' && resolution.acceptedUnverifiedRisk === true && (resolution.acceptedRiskReason?.trim().length ?? 0) >= 10;
}
