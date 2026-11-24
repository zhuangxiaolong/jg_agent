export type DeliverySystemType = 'MES5' | 'MES6' | 'WMS' | 'OTHER';
export type DeliveryProjectStatus = 'active' | 'on_hold' | 'completed' | 'archived';
export type DeliveryMilestoneStatus = 'not_started' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
export type DeliveryTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
export type DeliveryPriority = 'low' | 'medium' | 'high' | 'critical';
export type DeliveryIssueType = 'issue' | 'blocker' | 'risk' | 'question' | 'change';
export type DeliveryIssueStatus = 'open' | 'in_progress' | 'pending_customer' | 'resolved' | 'closed';
export type DeliveryDocumentCategory = 'contract' | 'handover' | 'requirement' | 'blueprint' | 'test' | 'go_live' | 'acceptance' | 'manual' | 'other';
export type DeliveryReportType = 'weekly' | 'risk' | 'plan' | 'meeting_summary' | 'other';
export type DeliveryHealth = 'red' | 'yellow' | 'green' | 'gray';

export interface DeliveryProject {
  id: string; code?: string; name: string; customerName: string; systemType: DeliverySystemType;
  productVersions: string[]; stage: string; status: DeliveryProjectStatus; projectManager?: string;
  members: string[]; plannedStartDate?: string; plannedEndDate?: string; description?: string;
  jiraKey?: string; linkedCodeProjectId?: string; createdAt: string; updatedAt: string; archivedAt?: string;
}
export interface DeliveryMilestone {
  id: string; deliveryProjectId: string; name: string; description?: string; sortOrder: number;
  plannedDate?: string; actualDate?: string; owner?: string; status: DeliveryMilestoneStatus;
  createdAt: string; updatedAt: string;
}
export interface DeliveryTask {
  id: string; deliveryProjectId: string; milestoneId?: string; title: string; description?: string;
  owner?: string; priority: DeliveryPriority; status: DeliveryTaskStatus; startDate?: string;
  dueDate?: string; completedAt?: string; completionNote?: string; linkedIssueIds: string[];
  linkedMeetingIds: string[]; createdAt: string; updatedAt: string;
}
export interface DeliverySourceRef { kind: 'document' | 'meeting' | 'jira' | 'manual'; id?: string; label: string }
export interface DeliveryIssue {
  id: string; deliveryProjectId: string; title: string; description?: string; type: DeliveryIssueType;
  priority: DeliveryPriority; status: DeliveryIssueStatus; owner?: string; discoveredAt: string;
  dueDate?: string; mitigation?: string; resolution?: string; linkedTaskIds: string[];
  linkedMilestoneId?: string; linkedMeetingIds: string[]; sourceRefs: DeliverySourceRef[];
  createdAt: string; updatedAt: string;
}
export interface DeliveryMeeting {
  id: string; deliveryProjectId: string; title: string; meetingAt: string;
  meetingType: 'internal' | 'customer' | 'onsite' | 'remote' | 'other'; attendees: string[];
  minutes: string; linkedTaskIds: string[]; linkedIssueIds: string[]; linkedMilestoneId?: string; createdAt: string; updatedAt: string;
}
export interface DeliveryDocument {
  id: string; deliveryProjectId: string; fileName: string; relativePath: string;
  category: DeliveryDocumentCategory; sizeBytes: number; sha256: string; mimeType?: string;
  extractedTextStatus: 'not_extracted' | 'ready' | 'failed' | 'stale'; createdAt: string; updatedAt: string;
}
export interface DeliveryReport {
  id: string; deliveryProjectId: string; reportType: DeliveryReportType; title: string;
  periodStart?: string; periodEnd?: string; markdown: string; status: 'draft' | 'final';
  sourceSnapshotHash: string; generatedAt?: string; runtimeKind?: string; model?: string;
  createdAt: string; updatedAt: string;
}
export interface DeliveryActivity {
  id: string; deliveryProjectId: string; entityType: 'project' | 'milestone' | 'task' | 'issue' | 'meeting' | 'document' | 'report';
  entityId: string; action: 'created' | 'updated' | 'status_changed' | 'archived' | 'deleted' | 'imported' | 'exported' | 'detached';
  summary: string; actor: string; createdAt: string;
}
export interface DeliveryProjectBundle {
  project: DeliveryProject; milestones: DeliveryMilestone[]; tasks: DeliveryTask[]; issues: DeliveryIssue[];
  meetings: DeliveryMeeting[]; documents: DeliveryDocument[]; reports: DeliveryReport[];
  activities: DeliveryActivity[]; health: DeliveryHealth; healthReasons: string[];
}
export interface DeliveryOverview {
  activeProjects: number; overdueTasks: number; highPriorityOpenIssues: number;
  upcomingMilestones: number; overdueMilestones: number; incompleteTasks: number;
  totalProjects: number; archivedProjects: number;
  attentionProjects: Array<{ project: DeliveryProject; health: DeliveryHealth; reasons: string[] }>;
  recentActivities: DeliveryActivity[];
}
export interface DeliveryProjectInput extends Omit<DeliveryProject, 'id' | 'createdAt' | 'updatedAt' | 'archivedAt'> { id?: string }
export interface DeliveryMilestoneInput extends Omit<DeliveryMilestone, 'id' | 'deliveryProjectId' | 'createdAt' | 'updatedAt'> { id?: string }
export interface DeliveryTaskInput extends Omit<DeliveryTask, 'id' | 'deliveryProjectId' | 'createdAt' | 'updatedAt'> { id?: string }
export type DeliveryTaskBatchInput = Pick<DeliveryTaskInput, 'title' | 'description' | 'owner' | 'priority' | 'startDate' | 'dueDate' | 'milestoneId'>;
export interface DeliveryIssueInput extends Omit<DeliveryIssue, 'id' | 'deliveryProjectId' | 'createdAt' | 'updatedAt'> { id?: string }
export interface DeliveryMeetingInput extends Omit<DeliveryMeeting, 'id' | 'deliveryProjectId' | 'createdAt' | 'updatedAt'> { id?: string }
export interface DeliveryReportInput extends Omit<DeliveryReport, 'id' | 'deliveryProjectId' | 'createdAt' | 'updatedAt'> { id?: string }

export interface DeliveryWorkbenchApi {
  overview(): Promise<DeliveryOverview>;
  listProjects(includeArchived?: boolean): Promise<DeliveryProject[]>;
  linkedCodeProjects(): Promise<Array<{ id: string; name: string }>>;
  createProject(input: DeliveryProjectInput): Promise<DeliveryProject>;
  updateProject(id: string, input: DeliveryProjectInput): Promise<DeliveryProject>;
  archiveProject(id: string): Promise<DeliveryProject>;
  getProject(id: string): Promise<DeliveryProjectBundle | null>;
  saveMilestone(projectId: string, input: DeliveryMilestoneInput): Promise<DeliveryMilestone>;
  deleteMilestone(projectId: string, id: string): Promise<void>;
  saveTask(projectId: string, input: DeliveryTaskInput): Promise<DeliveryTask>;
  saveTasks(projectId: string, inputs: DeliveryTaskBatchInput[]): Promise<DeliveryTask[]>;
  deleteTask(projectId: string, id: string): Promise<void>;
  saveIssue(projectId: string, input: DeliveryIssueInput): Promise<DeliveryIssue>;
  deleteIssue(projectId: string, id: string): Promise<void>;
  saveMeeting(projectId: string, input: DeliveryMeetingInput): Promise<DeliveryMeeting>;
  deleteMeeting(projectId: string, id: string): Promise<void>;
  importDocument(projectId: string, category: DeliveryDocumentCategory): Promise<DeliveryDocument | null>;
  detachDocument(projectId: string, id: string): Promise<void>;
  openDocument(projectId: string, id: string, reveal?: boolean): Promise<void>;
  saveReport(projectId: string, input: DeliveryReportInput): Promise<DeliveryReport>;
  buildReportDraft(projectId: string, input: { reportType: 'weekly' | 'risk'; periodStart?: string; periodEnd?: string }): Promise<DeliveryReport>;
  exportReport(projectId: string, id: string): Promise<string | null>;
}
