/** 0.7.1 第二迭代领域模型；只保存元数据、规则和可追溯证据，不保存密钥。 */
export type ProjectWorkspaceSystemType = 'MES5' | 'MES6' | 'WMS' | 'OTHER';
export type ProjectLifecycleStatus = 'active' | 'archived';
export type ProjectResourceType = 'repository' | 'jira_project' | 'knowledge_document' | 'operation_manual' | 'requirement' | 'data_template' | 'agent_task' | 'other';
export type ProjectResourceStatus = 'active' | 'superseded' | 'unavailable' | 'archived';
export type ProjectAssertionStatus = 'proposed' | 'confirmed' | 'rejected' | 'superseded';
export interface ProjectWorkspaceContext {
  id: string; projectCode?: string; name: string; customerName?: string; systemType: ProjectWorkspaceSystemType;
  productVersions: string[]; stage: string; owner?: string; description?: string; status: ProjectLifecycleStatus;
  createdAt: string; updatedAt: string;
}
export interface ProjectResourceLink {
  id: string; projectId: string; resourceType: ProjectResourceType; resourceId: string; displayName: string;
  versionLabel?: string; status: ProjectResourceStatus; sourceSha256?: string; linkedAt: string; localPath?: string; sourceSize?: number;
}
export interface ProjectSourceRef { type: string; id: string; anchor?: string }
export interface ProjectFact {
  id: string; projectId: string; title: string; content: string; category: string; status: ProjectAssertionStatus;
  sourceRefs: ProjectSourceRef[]; confirmedBy?: string; confirmedAt?: string; validFrom?: string; validTo?: string;
  supersedesFactId?: string; createdAt: string; updatedAt: string;
}
export interface ProjectDecision {
  id: string; projectId: string; title: string; decision: string; reason?: string; status: ProjectAssertionStatus;
  decisionMaker?: string; decisionAt?: string; sourceRefs: ProjectSourceRef[]; supersedesDecisionId?: string;
  createdAt: string; updatedAt: string;
}
export interface ProjectContextSnapshotSource { sourceType: string; sourceId: string; revisionId?: string; sha256?: string; anchor?: string; reason: string }
export interface ProjectContextSnapshot {
  id: string; projectId: string; taskId?: string; selectedSources: ProjectContextSnapshotSource[];
  contextHash: string; builderVersion: string; createdAt: string; contextText?: string;
}
export type MappingSystemType = 'MES5' | 'MES6' | 'WMS';
export type MappingJobStatus = 'draft' | 'parsing' | 'mapping' | 'review' | 'validating' | 'ready' | 'has_errors' | 'exported' | 'failed' | 'cancelled';
export interface MappingJob {
  id: string; projectId?: string; systemType: MappingSystemType; productVersion?: string; dataType: string;
  sourceFileName: string; sourceSha256: string; sourcePath: string; templateId?: string; templatePath?: string; templateSha256: string;
  status: MappingJobStatus; mappingRuleSetId?: string; createdAt: string; updatedAt: string; sourceOptions?: MappingParseOptions; templateOptions?: MappingParseOptions;
}
export interface MappingRuleSet {
  id: string; projectId?: string; systemType: MappingSystemType; dataType: string; templateSha256: string;
  version: number; rulesJson: string; status: 'draft' | 'confirmed' | 'archived'; confirmedBy?: string;
  confirmedAt?: string; createdAt: string;
}
export type FieldMappingStatus = 'suggested' | 'confirmed' | 'rejected' | 'unmapped' | 'conflict';
export interface FieldMapping {
  id: string; ruleSetId: string; sourceColumnKey: string; sourceColumnLabel: string; targetFieldKey: string;
  targetFieldLabel: string; transformDsl: Record<string, unknown>; confidence?: number; rationale?: string; status: FieldMappingStatus;
}
export interface MappingValidationIssue {
  id: string; mappingRunId: string; severity: 'error' | 'warning' | 'info'; ruleId: string; sheetName?: string;
  sourceRow?: number; sourceColumn?: string; targetField?: string; sourceValue?: string; convertedValue?: string;
  message: string; suggestion?: string; blocking: boolean; status: 'open' | 'resolved' | 'ignored';
}
export interface MappingRun {
  id: string; jobId: string; ruleSetVersion: number; engineVersion: string; sourceSha256: string; templateSha256: string;
  rowCount: number; successCount: number; errorCount: number; warningCount: number; outputPath?: string; outputSha256?: string;
  reportPath?: string; status: 'running' | 'passed' | 'has_errors' | 'failed' | 'cancelled'; startedAt: string; completedAt?: string;
}
export interface MappingSourceColumn { key: string; label: string; sampleValues: string[] }
export interface MappingParseOptions { sheetName?: string; headerRow?: number; dataStartRow?: number }
export interface MappingSourcePreview { fileName: string; digest: string; sheetName: string; columns: MappingSourceColumn[]; rows: string[][]; totalRows: number; hiddenRowsIgnored: number; sheets?: Array<{ name: string; hidden: boolean }>; warnings?: string[]; headerRow?: number; dataStartRow?: number; sourceRowNumbers?: number[]; structureValid?: boolean; uncachedFormulaCount?: number }
export interface MappingSuggestion { mapping: FieldMapping; score: number; candidates: string[] }
export interface MappingJobView extends Omit<MappingJob, 'sourcePath' | 'templatePath'> { templateFileName?: string }
export interface MappingJobSelection { projectId?: string; systemType: MappingSystemType; productVersion?: string; dataType: string }
export interface MappingConversionResult { run: MappingRun; headers: string[]; preview: string[][]; issues: MappingValidationIssue[]; path?: string }
