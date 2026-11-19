import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LearningAiProvider, LearningCandidate, LearningEligibility, LearningEvidenceRef, LearningFeedback, LearningSafetyFinding, LearningValidationResult } from '../../../../packages/domain/src/learning';
import type { Session } from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';
import { inspectPluginDirectory } from '../../../../packages/plugin-manager/src';
import type { PluginManagerService } from './plugin-manager';
import type { TaskEngineeringService } from './task-engineering';
import type { SettingsService } from './settings';

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function slug(value: string): string { return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'learned-skill'; }
const blockedPatterns: Array<[string, RegExp]> = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/i],
  ['api-key', /\b(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]{8,})/i],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['connection-string', /(?:Server|Data Source|Host)\s*=\s*[^;\s]+\s*;[^\r\n]{0,300}(?:Password|Pwd)\s*=/i],
];

export function scanLearningText(text: string): LearningSafetyFinding[] {
  const findings: LearningSafetyFinding[] = [];
  for (const [code, pattern] of blockedPatterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) findings.push({ code, severity: 'block', message: '检测到可能的凭据或秘密信息；请移除后再保存或发布。', position: match.index });
  }
  for (const [code, pattern] of [['phone-like', /(?<!\d)1[3-9]\d{9}(?!\d)/], ['customer-data', /(?:客户名称|客户订单|生产工单|员工姓名|身份证号)\s*[:：]/]] as Array<[string, RegExp]>) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) findings.push({ code, severity: 'warning', message: '可能包含客户或个人信息，请人工确认已脱敏。', position: match.index });
  }
  return findings.sort((left, right) => left.position - right.position || left.code.localeCompare(right.code));
}

function sanitizeSourceText(text: string): string {
  let value = text;
  for (const [, pattern] of blockedPatterns) { pattern.lastIndex = 0; value = value.replace(pattern, '[已脱敏]'); }
  return value.slice(0, 20000);
}

async function boundedResponseText(response: Response, maximum: number): Promise<string> {
  if (!response.body) throw new Error('AI 响应为空；本地候选保持不变');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) { await reader.cancel(); throw new Error('AI 响应超过安全大小限制；本地候选保持不变'); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export class LearningEngineService {
  constructor(private readonly store: LocalStore, private readonly dataRoot: string, private readonly plugins: PluginManagerService, private readonly engineering: () => TaskEngineeringService, private readonly redact: (text: string) => string, private readonly settings?: Pick<SettingsService, 'profiles' | 'credential'>) {}

  private session(sessionId: string): Session {
    const session = this.store.listSessions().find(item => item.id === sessionId);
    if (!session) throw new Error('学习来源会话不存在');
    return session;
  }

  async eligibility(sessionId: string, taskId: string): Promise<LearningEligibility> {
    const session = this.session(sessionId);
    const task = this.store.listAgentTasks(sessionId).find(item => item.id === taskId);
    if (!task || task.projectId !== session.projectId) throw new Error('学习来源任务不存在或项目不一致');
    const contracts = this.store.getAgentTaskContractVersions(sessionId, taskId);
    const contract = contracts.at(-1);
    const blockReasons: string[] = [];
    const warnings: string[] = [];
    const evidenceRefs: LearningEvidenceRef[] = [];
    if (!contract || contract.version !== task.contractVersion) blockReasons.push('任务缺少与当前版本一致的 Task Contract。');
    else evidenceRefs.push({ kind: 'task_contract', refId: `${taskId}@${contract.version}`, contentHash: contract.contentHash, contractVersion: contract.version, status: 'current' });
    const execution = task.executionStatus;
    const failed = ['FAILED', 'CANCELLED', 'INTERRUPTED', 'BLOCKED'].includes(execution ?? task.status);
    const completed = execution === 'COMPLETED' || task.status === 'COMPLETED';
    if (!completed && !failed) blockReasons.push('任务尚未进入可沉淀的终态。');
    const linkedEvidence = this.store.listTaskEvidence(sessionId, taskId).filter(record => task.evidenceIds?.includes(record.id) && record.contractVersion === task.contractVersion);
    for (const record of linkedEvidence) evidenceRefs.push({ kind: 'task_evidence', refId: record.id, contentHash: record.contentHash, contractVersion: record.contractVersion, status: record.status });
    const codeTask = ['implementation', 'review', 'test', 'integration'].includes(contract?.contract.taskType ?? '');
    let currentPassedEvidence = false;
    if (completed && codeTask && linkedEvidence.some(record => record.status === 'passed' && record.integrityVerified)) {
      try {
        const detail = await this.engineering().inspect(sessionId, taskId);
        currentPassedEvidence = task.verificationStatus === 'PASSED' && detail.evidenceFreshness?.status === 'current';
      } catch { currentPassedEvidence = false; }
    }
    if (completed && codeTask && !currentPassedEvidence) blockReasons.push('代码类任务必须关联当前契约下真实通过且指纹仍有效的构建/测试证据。');
    if (completed && !codeTask) warnings.push('该候选为人工复核级经验，不代表代码构建或测试通过。');
    if (failed) warnings.push('失败、取消、中断或阻塞任务只能创建问题复盘候选，不能发布为可执行 Skill。');
    const candidateTypes: LearningEligibility['candidateTypes'] = [];
    if (completed && !blockReasons.length) candidateTypes.push('skill');
    if (failed && contract && !blockReasons.some(reason => reason.includes('Task Contract'))) candidateTypes.push('failure_lesson');
    return { eligible: candidateTypes.length > 0, candidateTypes, blockReasons, warnings, requiresManualConfirmation: !codeTask || failed, evidenceRefs };
  }

  listCandidates(sessionId?: string): LearningCandidate[] { return this.store.listLearningCandidates(sessionId); }

  async createCandidate(input: { sessionId: string; taskId: string; candidateType: 'skill' | 'failure_lesson'; selectedEvidenceIds: string[]; manualConfirmation: boolean }): Promise<LearningCandidate> {
    const eligibility = await this.eligibility(input.sessionId, input.taskId);
    if (!eligibility.candidateTypes.includes(input.candidateType)) throw new Error(eligibility.blockReasons.join(' ') || '当前任务不能创建此类型候选');
    if (eligibility.requiresManualConfirmation && !input.manualConfirmation) throw new Error('请先确认该来源为人工复核级材料。');
    if (!Array.isArray(input.selectedEvidenceIds) || input.selectedEvidenceIds.length > 100 || new Set(input.selectedEvidenceIds).size !== input.selectedEvidenceIds.length) throw new Error('请选择有效且不重复的来源证据');
    const selected = eligibility.evidenceRefs.filter(item => item.kind === 'task_evidence' && input.selectedEvidenceIds.includes(item.refId));
    if (input.selectedEvidenceIds.some(id => !selected.some(item => item.refId === id))) throw new Error('候选引用了不属于当前任务的证据');
    const session = this.session(input.sessionId);
    const task = this.store.listAgentTasks(input.sessionId).find(item => item.id === input.taskId)!;
    const contract = this.store.getAgentTaskContractVersions(input.sessionId, input.taskId).at(-1)!;
    const evidence = [eligibility.evidenceRefs.find(item => item.kind === 'task_contract')!, ...selected];
    const title = task.name.trim().slice(0, 120) || '任务经验';
    const skillName = slug(title);
    const rawGoal = contract.contract.goal;
    const findings = scanLearningText(rawGoal);
    const goal = sanitizeSourceText(this.redact(rawGoal));
    const body = input.candidateType === 'failure_lesson'
      ? `# 问题复盘草稿\n\n> 仅供人工复核；不可直接作为可执行 Skill 发布。\n\n## 任务目标\n${goal}\n\n## 可复用原因与改进步骤\n\n- 待人工根据证据补充。\n\n## 证据\n${selected.map(item => `- ${item.kind}: ${item.refId} (${item.status ?? 'unknown'})`).join('\n') || '- 尚未选择执行证据'}\n`
      : `---\nname: ${skillName}\ndescription: '${title.replaceAll("'", "''")}'\n---\n\n# ${title}\n\n## 适用范围\n\n- 待人工确认适用系统、前置条件和不适用场景。\n\n## 目标\n\n${goal}\n\n## 操作步骤\n\n1. 待人工根据来源证据补充可复用步骤。\n\n## 检查点与期望结果\n\n- 待人工填写；不得把任务完成状态当作验证通过。\n\n## 验证方法\n\n${selected.map(item => `- 来源证据 ${item.refId}：${item.status ?? 'unknown'}（仍需人工核对原始验证记录）`).join('\n') || '- 无代码验证证据；需人工补充适用的验证方式。'}\n`;
    const now = new Date().toISOString();
    const candidate: LearningCandidate = {
      id: randomUUID(), revision: 1, sessionId: session.id, taskId: task.id, taskType: contract.contract.taskType,
      evidenceLevel: input.candidateType === 'failure_lesson' ? 'failure_lesson' : ['analysis', 'design', 'documentation', 'other'].includes(contract.contract.taskType) ? 'review_only' : 'verified',
      status: 'draft', title, suggestedSkillName: skillName, description: title, systemScope: ['GENERAL'],
      sourceTaskIds: [task.id], evidence, draftSkillMarkdown: body, generationMethod: 'local',
      safetyFindings: findings, createdAt: now, updatedAt: now,
    };
    this.store.saveLearningCandidate(candidate);
    return candidate;
  }

  updateCandidate(input: { candidateId: string; expectedRevision: number; title: string; suggestedSkillName: string; description: string; draftSkillMarkdown: string; systemScope: LearningCandidate['systemScope'] }): LearningCandidate {
    const current = this.store.getLearningCandidate(input.candidateId);
    if (!current || current.revision !== input.expectedRevision) throw new Error('学习候选版本已变化，请刷新后重试');
    if (!['draft', 'needs_review', 'approved'].includes(current.status) || current.evidenceLevel === 'failure_lesson' && input.draftSkillMarkdown.startsWith('---')) throw new Error('当前候选状态或类型不允许编辑为可发布 Skill');
    const text = input.draftSkillMarkdown;
    const findings = scanLearningText(`${input.title}\n${input.suggestedSkillName}\n${input.description}\n${text}`);
    if (findings.some(item => item.severity === 'block')) throw new Error('检测到可能的凭据或秘密信息，候选未保存；请移除敏感内容。');
    if (text.length > 100000 || !input.title.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.suggestedSkillName) || input.systemScope.length < 1 || input.systemScope.some(scope => !['MES5', 'MES6', 'WMS', 'GENERAL'].includes(scope))) throw new Error('候选名称、正文或适用范围无效');
    const updated: LearningCandidate = { ...current, revision: current.revision + 1, title: input.title.trim().slice(0, 120), suggestedSkillName: input.suggestedSkillName, description: input.description.trim().slice(0, 300), draftSkillMarkdown: text, systemScope: [...new Set(input.systemScope)], status: 'needs_review', generationMethod: 'user_edited', safetyFindings: findings, updatedAt: new Date().toISOString() };
    this.store.saveLearningCandidate(updated, current.revision);
    return updated;
  }

  listAiProviders(): LearningAiProvider[] {
    return (this.settings?.profiles() ?? []).filter(profile => profile.hasKey).map(profile => ({ id: profile.id, name: profile.name, models: profile.models }));
  }

  async generateAiDraft(input: { candidateId: string; expectedRevision: number; providerId: string; model: string; selectedEvidenceIds: string[]; selectedExcerpt?: string }): Promise<LearningCandidate> {
    const candidate = this.store.getLearningCandidate(input.candidateId);
    if (!candidate || candidate.revision !== input.expectedRevision) throw new Error('学习候选版本已变化，请刷新后重试');
    if (!['draft', 'needs_review'].includes(candidate.status) || candidate.evidenceLevel === 'failure_lesson') throw new Error('当前候选状态或类型不允许 AI 整理');
    if (!this.settings) throw new Error('AI 草拟服务尚未配置');
    if (!Array.isArray(input.selectedEvidenceIds) || input.selectedEvidenceIds.length > 100 || new Set(input.selectedEvidenceIds).size !== input.selectedEvidenceIds.length) throw new Error('请选择有效且不重复的来源证据');
    if (input.selectedExcerpt !== undefined && (typeof input.selectedExcerpt !== 'string' || input.selectedExcerpt.length > 8000)) throw new Error('手动选择的任务片段不能超过 8000 个字符');
    const provider = this.settings.profiles().find(profile => profile.id === input.providerId && profile.hasKey);
    if (!provider || !provider.models.includes(input.model)) throw new Error('所选模型中转站或模型不可用');
    const contractRef = candidate.evidence.find(item => item.kind === 'task_contract');
    const contracts = this.store.getAgentTaskContractVersions(candidate.sessionId, candidate.taskId);
    const contract = contracts.at(-1);
    if (!contract || contract.version !== contractRef?.contractVersion || contract.contentHash !== contractRef.contentHash) throw new Error('任务契约已变化，候选来源过期，请重新生成本地草稿');
    const task = this.store.listAgentTasks(candidate.sessionId).find(item => item.id === candidate.taskId);
    if (!task || task.contractVersion !== contract.version) throw new Error('任务与当前契约版本不一致，不能整理 AI 草稿');
    const selectedRefs = candidate.evidence.filter(item => item.kind === 'task_evidence' && input.selectedEvidenceIds.includes(item.refId));
    if (input.selectedEvidenceIds.some(id => !selectedRefs.some(item => item.refId === id))) throw new Error('AI 草稿引用了未关联到候选的证据');
    const evidenceRecords = this.store.listTaskEvidence(candidate.sessionId, candidate.taskId).filter(record => selectedRefs.some(item => item.refId === record.id) && task.evidenceIds?.includes(record.id) && record.contractVersion === contract.version);
    if (evidenceRecords.length !== selectedRefs.length) throw new Error('所选验证证据已变化或不再属于当前任务');
    const rawExcerpt = input.selectedExcerpt?.trim() ?? '';
    const evidenceSummary = evidenceRecords.map(record => ({
      id: record.id, type: record.evidenceType, status: record.status, source: record.source,
      command: record.command?.slice(0, 500), exitCode: record.exitCode, testCount: record.testCount,
      durationMs: record.durationMs, integrityVerified: record.integrityVerified,
      limitations: record.limitations?.slice(0, 20), codeFingerprint: record.codeFingerprint,
    }));
    const rawPacket = JSON.stringify({
      title: candidate.title, description: candidate.description,
      contract: { taskType: contract.contract.taskType, title: contract.contract.title, goal: contract.contract.goal, description: contract.contract.description, outputExpectations: contract.contract.outputExpectations, acceptanceCriteria: contract.contract.acceptanceCriteria },
      selectedEvidence: evidenceSummary, selectedExcerpt: rawExcerpt, priorDraft: candidate.draftSkillMarkdown,
    });
    if (scanLearningText(rawPacket).some(item => item.severity === 'block')) throw new Error('所选内容包含疑似凭据，已阻止发送；请先脱敏并重新选择');
    const packet = sanitizeSourceText(this.redact(rawPacket));
    const systemPrompt = `你负责把用户明确选择的任务来源整理为可审阅的中文 Agent Skill。只输出完整 Markdown，含现有格式要求的 YAML Frontmatter；name 必须严格为 ${candidate.suggestedSkillName}，description 使用候选说明。严禁编造代码事实、客户规则、测试结论或验证结果；证据没有支持的步骤须标注“待人工确认”。不复制凭据、个人信息、客户特定值、大段代码或完整原始数据。保留失败/限制信息，不将任务完成等同于验证通过。`;
    const body = JSON.stringify({ model: input.model, store: false, stream: false, instructions: systemPrompt, input: [{ role: 'user', content: [{ type: 'input_text', text: packet }] }] });
    if (Buffer.byteLength(body, 'utf8') > 64000) throw new Error('所选来源过长，请减少片段后重试');
    const apiKey = this.settings.credential(provider.id).read(provider.baseUrl);
    if (!apiKey) throw new Error('所选模型中转站凭据不可用');
    let response: Response;
    try {
      response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/responses`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body,
      });
    } catch {
      throw new Error('AI 草稿请求失败或超时；本地候选保持不变');
    }
    if (!response.ok) throw new Error(`AI 草稿请求失败（HTTP ${response.status}）；本地候选保持不变`);
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > 512000) throw new Error('AI 响应超过安全大小限制；本地候选保持不变');
    const responseText = await boundedResponseText(response, 512000);
    let payload: { status?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
    try { payload = JSON.parse(responseText) as typeof payload; } catch { throw new Error('AI 响应格式无效；本地候选保持不变'); }
    if (['failed', 'incomplete', 'cancelled'].includes(payload.status ?? '') || !Array.isArray(payload.output)) throw new Error('AI 未返回完整草稿；本地候选保持不变');
    const markdown = payload.output.filter(item => item?.type === 'message').flatMap(item => item.content ?? []).filter(item => item?.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('\n').trim();
    if (!markdown || markdown.length > 100000) throw new Error('AI 未返回有效 Skill Markdown；本地候选保持不变');
    if (scanLearningText(markdown).some(item => item.severity === 'block')) throw new Error('AI 草稿含疑似凭据，已丢弃；本地候选保持不变');
    const safeMarkdown = this.redact(markdown);
    const findings = scanLearningText(safeMarkdown);
    const current = this.store.getLearningCandidate(candidate.id);
    if (!current || current.revision !== input.expectedRevision) throw new Error('候选在 AI 请求期间已变化；草稿未覆盖，请刷新后重试');
    const latestTask = this.store.listAgentTasks(candidate.sessionId).find(item => item.id === candidate.taskId);
    const latestContract = this.store.getAgentTaskContractVersions(candidate.sessionId, candidate.taskId).at(-1);
    const latestEvidence = this.store.listTaskEvidence(candidate.sessionId, candidate.taskId);
    if (!latestTask || latestTask.contractVersion !== contract.version || !latestContract || latestContract.contentHash !== contract.contentHash || input.selectedEvidenceIds.some(id => !latestTask.evidenceIds?.includes(id) || !latestEvidence.some(record => record.id === id && record.contractVersion === contract.version))) throw new Error('任务或验证证据在 AI 请求期间已变化；草稿未保存，请重新检查来源');
    const updated: LearningCandidate = { ...current, revision: current.revision + 1, draftSkillMarkdown: safeMarkdown, status: 'needs_review', generationMethod: 'ai', safetyFindings: findings, updatedAt: new Date().toISOString() };
    this.store.saveLearningCandidate(updated, input.expectedRevision);
    return updated;
  }

  private async inspectDraft(candidate: LearningCandidate): Promise<LearningValidationResult> {
    const contentHash = hash(candidate.draftSkillMarkdown);
    const findings = scanLearningText(candidate.draftSkillMarkdown);
    const safeName = slug(candidate.suggestedSkillName);
    const root = path.join(this.dataRoot, 'learning', 'validation', randomUUID());
    try {
      await mkdir(path.join(root, 'skills', safeName), { recursive: true });
      await writeFile(path.join(root, 'plugin.json'), JSON.stringify({ name: `learned-${safeName}`, version: `0.0.${candidate.revision}`, description: candidate.description.slice(0, 300) }), { flag: 'wx' });
      await writeFile(path.join(root, 'skills', safeName, 'SKILL.md'), candidate.draftSkillMarkdown, { flag: 'wx' });
      const inspected = await inspectPluginDirectory(root);
      for (const diagnostic of inspected.diagnostics) findings.push({ code: `plugin-${diagnostic.code}`, severity: diagnostic.severity === 'error' ? 'block' : 'warning', message: diagnostic.message.slice(0, 300), position: 0 });
    } catch (error) {
      findings.push({ code: 'skill-format', severity: 'block', message: error instanceof Error ? error.message.slice(0, 300) : 'Skill 包格式无效。', position: 0 });
    } finally { await rm(root, { recursive: true, force: true }).catch(() => undefined); }
    const knownNames = new Set((await this.plugins.listSkills()).map(skill => slug(skill.name)));
    if (knownNames.has(safeName)) findings.push({ code: 'duplicate-name', severity: 'warning', message: '已存在同名 Skill；请审核是否应合并或创建新版本。', position: 0 });
    return { valid: !findings.some(item => item.severity === 'block'), findings, contentHash };
  }

  async validateCandidate(candidateId: string): Promise<LearningValidationResult> {
    const candidate = this.store.getLearningCandidate(candidateId);
    if (!candidate) throw new Error('学习候选不存在');
    return this.inspectDraft(candidate);
  }

  async approveCandidate(input: { candidateId: string; expectedRevision: number }): Promise<LearningCandidate> {
    const candidate = this.store.getLearningCandidate(input.candidateId);
    if (!candidate || candidate.revision !== input.expectedRevision) throw new Error('学习候选版本已变化，请刷新后重试');
    if (candidate.evidenceLevel === 'failure_lesson') throw new Error('问题复盘候选不能批准为可执行 Skill');
    await this.assertEvidenceCurrent(candidate);
    const result = await this.inspectDraft(candidate);
    if (!result.valid) throw new Error('候选校验未通过，请先修复阻断项。');
    if (this.store.getLearningCandidate(candidate.id)?.revision !== input.expectedRevision) throw new Error('候选在校验期间已变化，请刷新后重试');
    const approved: LearningCandidate = { ...candidate, revision: candidate.revision + 1, status: 'approved', safetyFindings: result.findings, updatedAt: new Date().toISOString() };
    this.store.saveLearningCandidate(approved, input.expectedRevision);
    return approved;
  }

  async publishCandidate(input: { candidateId: string; expectedRevision: number; scope: 'disabled' | 'project' }): Promise<LearningCandidate> {
    const candidate = this.store.getLearningCandidate(input.candidateId);
    if (!candidate || candidate.revision !== input.expectedRevision) throw new Error('学习候选版本已变化，请刷新后重试');
    if (candidate.status !== 'approved' || candidate.evidenceLevel === 'failure_lesson') throw new Error('仅审核批准的正向经验 Skill 可发布');
    await this.assertEvidenceCurrent(candidate);
    if (input.scope === 'project' && !this.session(candidate.sessionId).projectId) throw new Error('项目范围发布需要绑定项目');
    const validation = await this.inspectDraft(candidate);
    if (!validation.valid) throw new Error('发布前校验未通过，请重新审核候选。');
    if (this.store.getLearningCandidate(candidate.id)?.revision !== input.expectedRevision) throw new Error('候选在发布校验期间已变化，请刷新后重试');
    const priorVersions = this.store.listPlugins().filter(plugin => plugin.origin === 'learned' && plugin.sourceCandidateId === candidate.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const pluginName = `learned-${slug(candidate.suggestedSkillName)}-${candidate.id.slice(0, 8)}`;
    const skillDir = path.join(this.dataRoot, 'learning', 'staging', randomUUID());
    try {
      await mkdir(path.join(skillDir, 'skills', candidate.suggestedSkillName), { recursive: true });
      await writeFile(path.join(skillDir, 'plugin.json'), JSON.stringify({ name: pluginName, version: `0.0.${priorVersions.length + 1}`, description: candidate.description.slice(0, 300) }), { flag: 'wx' });
      await writeFile(path.join(skillDir, 'skills', candidate.suggestedSkillName, 'SKILL.md'), candidate.draftSkillMarkdown, { flag: 'wx' });
      const packageReview = await inspectPluginDirectory(skillDir);
      if (packageReview.diagnostics.some(item => item.severity === 'error') || packageReview.skills.length !== 1 || packageReview.executableResources.length) throw new Error('学习包未通过 Plugin Manager 包校验。');
      const imported = await this.plugins.importPlugin({ path: skillDir, sourceType: 'folder', provenance: { origin: 'learned', sourceCandidateId: candidate.id, sourceTaskIds: candidate.sourceTaskIds, systemScope: candidate.systemScope, createdBy: 'local-user', publishedAt: new Date().toISOString(), ...(priorVersions[0] ? { previousVersionPluginId: priorVersions[0].id } : {}) } });
      const pluginValidation = await this.plugins.validatePlugin(imported.plugin.id);
      if (!pluginValidation.valid) throw new Error('Plugin Manager 最终校验失败，插件保持未信任且禁用。');
      const skill = (await this.plugins.listSkills(imported.plugin.id)).find(item => item.name === candidate.suggestedSkillName);
      if (!skill) throw new Error('发布包缺少预期 Skill。');
      await this.plugins.trustPlugin(imported.plugin.id, 'install');
      await this.plugins.enablePlugin(imported.plugin.id, true);
      await this.plugins.setSkillScope({ skillId: skill.id, scope: input.scope === 'project' ? 'project' : 'disabled', ...(input.scope === 'project' ? { projectId: this.session(candidate.sessionId).projectId! } : {}) });
      const current = this.store.getLearningCandidate(candidate.id);
      if (!current || current.revision !== input.expectedRevision) {
        await this.plugins.setSkillScope({ skillId: skill.id, scope: 'disabled' }).catch(() => undefined);
        await this.plugins.enablePlugin(imported.plugin.id, false).catch(() => undefined);
        throw new Error('候选在发布期间已变化；新插件保持禁用，请刷新后重试。');
      }
      const published: LearningCandidate = { ...current, revision: current.revision + 1, status: 'published', publishedPluginId: imported.plugin.id, publishedSkillId: skill.id, publishedVersion: imported.plugin.version, publishedHash: imported.plugin.contentHash, safetyFindings: validation.findings, updatedAt: new Date().toISOString() };
      this.store.saveLearningCandidate(published, input.expectedRevision);
      return published;
    } finally { await rm(skillDir, { recursive: true, force: true }).catch(() => undefined); }
  }

  private async assertEvidenceCurrent(candidate: LearningCandidate): Promise<void> {
    const eligibility = await this.eligibility(candidate.sessionId, candidate.taskId);
    if (!eligibility.candidateTypes.includes('skill')) throw new Error('候选来源任务已不满足沉淀门槛，请重新检查验证证据');
    const currentRefs = new Map(eligibility.evidenceRefs.map(item => [`${item.kind}:${item.refId}`, item]));
    if (candidate.evidence.some(item => {
      const current = currentRefs.get(`${item.kind}:${item.refId}`);
      return !current || current.contentHash !== item.contentHash || current.contractVersion !== item.contractVersion;
    })) throw new Error('候选引用的任务契约或验证证据已过期，不能批准或发布');
  }

  rejectCandidate(input: { candidateId: string; expectedRevision: number }): LearningCandidate {
    const candidate = this.store.getLearningCandidate(input.candidateId);
    if (!candidate || candidate.revision !== input.expectedRevision) throw new Error('学习候选版本已变化，请刷新后重试');
    if (['published', 'superseded'].includes(candidate.status)) throw new Error('已发布或已替代版本不能作为草稿拒绝');
    const rejected: LearningCandidate = { ...candidate, revision: candidate.revision + 1, status: 'rejected', updatedAt: new Date().toISOString() };
    this.store.saveLearningCandidate(rejected, input.expectedRevision);
    return rejected;
  }

  listUsage(sessionId: string) {
    this.session(sessionId);
    const feedback = new Map(this.store.listLearningFeedbacks().map(item => [item.eventId, item.feedback]));
    return this.store.listSkillUsageEvents(500).filter(event => event.sessionId === sessionId).map(event => ({ eventId: event.id, sessionId: event.sessionId, turnId: event.turnId, skillId: event.skillId, pluginId: event.pluginId, runtimeKind: event.runtimeKind, pluginVersion: event.pluginVersion, pluginHash: event.pluginHash, skillHash: event.skillHash, eventType: event.eventType, selectionSource: event.selectionSource, createdAt: event.createdAt, ...(feedback.has(event.id) ? { feedback: feedback.get(event.id) } : {}) }));
  }

  submitFeedback(input: { eventId: string; feedback: LearningFeedback }): void {
    if (!['helpful', 'not_helpful', 'incorrect'].includes(input.feedback)) throw new Error('Skill 使用评价无效');
    this.store.saveLearningFeedback(input.eventId, input.feedback, new Date().toISOString());
  }
}
