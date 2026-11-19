export type SkillCompatibilityStatus = 'Full' | 'Partial' | 'MetadataOnly' | 'Unsupported' | 'Invalid';
export type SkillScope = 'disabled' | 'global' | 'project';

export interface SkillMatcherCandidate {
  skillId: string;
  pluginId: string;
  name: string;
  description: string;
  tags?: string[];
  pluginEnabled: boolean;
  trusted: boolean;
  skillEnabled: boolean;
  compatibility: SkillCompatibilityStatus;
  scope: SkillScope;
  projectId?: string;
}

export interface SkillMatchInput {
  candidates: SkillMatcherCandidate[];
  userPrompt: string;
  projectSystem?: string;
  projectId?: string;
  explicitSkillIds?: string[];
  disabledSkillIds?: string[];
  limit?: number;
}

export interface SkillMatchResult {
  skillId: string;
  pluginId: string;
  name: string;
  description: string;
  score: number;
  selectionSource: 'automatic' | 'manual';
  reason: string;
}

function terms(value: string): Set<string> {
  const normalized = value.toLowerCase().normalize('NFKC');
  const result = new Set(normalized.match(/[a-z0-9][a-z0-9._+-]*/g) ?? []);
  const cjk = normalized.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const sequence of cjk) {
    if (sequence.length === 1) result.add(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) result.add(sequence.slice(index, index + 2));
  }
  return result;
}

function scoreCandidate(candidate: SkillMatcherCandidate, prompt: string, system: string): { score: number; reasons: string[] } {
  const promptTerms = terms(prompt);
  const systemTerms = terms(system);
  const nameTerms = terms(candidate.name);
  const descriptionTerms = terms(candidate.description);
  const tagTerms = (candidate.tags ?? []).flatMap(tag => [...terms(tag)]);
  const reasons: string[] = [];
  let score = 0;
  if (candidate.name.trim() && prompt.toLowerCase().includes(candidate.name.toLowerCase())) {
    score += 8;
    reasons.push('名称精确匹配');
  }
  const nameMatches = [...nameTerms].filter(term => promptTerms.has(term));
  if (nameMatches.length) {
    score += nameMatches.length * 4;
    reasons.push('名称关键词匹配');
  }
  const tagMatches = [...new Set(tagTerms)].filter(term => promptTerms.has(term));
  if (tagMatches.length) {
    score += tagMatches.length * 3;
    reasons.push('标签匹配');
  }
  const descriptionMatches = [...descriptionTerms].filter(term => promptTerms.has(term));
  if (descriptionMatches.length) {
    score += Math.min(descriptionMatches.length, 5);
    reasons.push('说明关键词匹配');
  }
  if (system.trim()) {
    const systemMatches = [...new Set([...nameTerms, ...tagTerms])].filter(term => systemTerms.has(term));
    if (systemMatches.length) {
      score += Math.min(systemMatches.length * 2, 4);
      reasons.push('项目系统匹配');
    }
  }
  return { score, reasons };
}

export function matchSkills(input: SkillMatchInput): SkillMatchResult[] {
  const limit = input.limit ?? 3;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('Skill 推荐数量无效');
  const explicit = new Set(input.explicitSkillIds ?? []);
  const disabled = new Set(input.disabledSkillIds ?? []);
  const prompt = input.userPrompt.slice(0, 100_000);
  const system = (input.projectSystem ?? '').slice(0, 500);
  return input.candidates
    .filter(candidate => candidate.pluginEnabled && candidate.trusted && candidate.skillEnabled
      && candidate.compatibility !== 'Unsupported' && candidate.compatibility !== 'Invalid'
      && candidate.compatibility !== 'MetadataOnly' && candidate.scope !== 'disabled'
      && (candidate.scope !== 'project' || !!input.projectId && candidate.projectId === input.projectId)
      && !disabled.has(candidate.skillId))
    .map(candidate => {
      const selected = explicit.has(candidate.skillId);
      const match = scoreCandidate(candidate, prompt, system);
      return {
        candidate,
        score: selected ? Math.max(match.score, 1) : match.score,
        selectionSource: selected ? 'manual' as const : 'automatic' as const,
        reason: selected ? '用户已选择' : match.reasons.join('、'),
      };
    })
    .filter(result => result.selectionSource === 'manual' || result.score > 0)
    .sort((left, right) => Number(right.selectionSource === 'manual') - Number(left.selectionSource === 'manual')
      || right.score - left.score
      || left.candidate.skillId.localeCompare(right.candidate.skillId))
    .slice(0, limit)
    .map(({ candidate, score, selectionSource, reason }) => ({
      skillId: candidate.skillId,
      pluginId: candidate.pluginId,
      name: candidate.name,
      description: candidate.description,
      score,
      selectionSource,
      reason,
    }));
}
