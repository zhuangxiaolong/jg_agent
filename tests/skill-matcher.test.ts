import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchSkills, type SkillMatcherCandidate } from '../packages/plugin-manager/src/skill-matcher';

const candidate = (overrides: Partial<SkillMatcherCandidate> = {}): SkillMatcherCandidate => ({
  skillId: 'mes:release', pluginId: 'mes', name: 'MES 发布检查', description: '发布前检查版本和构建', tags: ['发布', '构建'],
  pluginEnabled: true, trusted: true, skillEnabled: true, compatibility: 'Full', scope: 'global', ...overrides,
});

test('确定性推荐按显式选择、名称和标签匹配排序并限制前三项', () => {
  const result = matchSkills({
    candidates: [candidate({ skillId: 'a', name: '通用指南', description: '日常说明' }), candidate({ skillId: 'b', name: '发布助手', tags: ['release'] }), candidate({ skillId: 'c', name: '构建检查', tags: ['build'] }), candidate({ skillId: 'd', name: 'MES 发布检查' })],
    userPrompt: 'MES 发布检查并确认构建',
    explicitSkillIds: ['b'],
  });
  assert.deepEqual(result.map(item => item.skillId), ['b', 'd', 'c']);
  assert.equal(result[0].selectionSource, 'manual');
  assert.equal(result[1].selectionSource, 'automatic');
});

test('拒绝未信任、停用、无兼容及跨项目 Skill，且不填充低分候选', () => {
  const result = matchSkills({
    candidates: [
      candidate({ skillId: 'untrusted', trusted: false }),
      candidate({ skillId: 'disabled', scope: 'disabled' }),
      candidate({ skillId: 'unsupported', compatibility: 'Unsupported' }),
      candidate({ skillId: 'wrong-project', scope: 'project', projectId: 'other' }),
      candidate({ skillId: 'unmatched', name: '无关说明', description: '与任务无关', tags: [] }),
      candidate({ skillId: 'match', name: '发布助手', tags: ['发布'] }),
    ],
    userPrompt: '请检查发布事项',
    projectId: 'current',
  });
  assert.deepEqual(result.map(item => item.skillId), ['match']);
});

test('项目系统信息可作为次级匹配信号，排序稳定', () => {
  const input = {
    candidates: [candidate({ skillId: 'b', name: 'MES 支持', tags: ['MES'] }), candidate({ skillId: 'a', name: 'MES 支持', tags: ['MES'] })],
    userPrompt: '处理发布',
    projectSystem: 'MES',
  };
  assert.deepEqual(matchSkills(input).map(item => item.skillId), ['a', 'b']);
});
