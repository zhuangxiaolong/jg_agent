import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { WorkspaceIndexService } from '../packages/performance/src';

async function main() {
const project = process.cwd();
const sourceRoot = path.join(project, 'packages', 'agent-runtime');
const output = path.join(project, 'docs', 'performance');
const files = execFileSync('git', ['-C', sourceRoot, 'ls-files', '-z'], { encoding: 'utf8', windowsHide: true }).split('\0').filter(file => /\.ts$/.test(file)).sort();
async function fingerprint() {
  const digest = createHash('sha256');
  for (const filename of files) { digest.update(filename); digest.update(await readFile(path.join(sourceRoot, filename))); }
  return digest.digest('hex');
}
const before = await fingerprint();
const cache = await mkdtemp(path.join(os.tmpdir(), 'jg-performance-baseline-'));
const samples: Array<{ repeat: number; coldMs: number; warmMs: number; restartMs: number; coldParsed: number; warmParsed: number; restartParsed: number; fileCount: number }> = [];
try {
  for (let repeat = 1; repeat <= 3; repeat++) {
    const cacheRoot = path.join(cache, String(repeat)); const identity = { workspaceId: 'local-baseline', repositoryId: 'agent-runtime', worktreeId: before, root: sourceRoot };
    const service = new WorkspaceIndexService({ cacheRoot });
    let started = performance.now(); const cold = await service.ensureFresh(identity); const coldMs = performance.now() - started;
    if (cold.state !== 'ready') throw new Error(cold.error ?? '索引未成功');
    started = performance.now(); const warm = await service.ensureFresh(identity); const warmMs = performance.now() - started; service.close();
    const restarted = new WorkspaceIndexService({ cacheRoot }); started = performance.now(); const restart = await restarted.ensureFresh(identity); const restartMs = performance.now() - started; restarted.close();
    samples.push({ repeat, coldMs, warmMs, restartMs, coldParsed: cold.parsedFiles, warmParsed: warm.parsedFiles, restartParsed: restart.parsedFiles, fileCount: cold.fileCount });
  }
} finally { await rm(cache, { recursive: true, force: true }); }
const after = await fingerprint(); const stable = before === after;
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const environment = { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 1024 ** 3), nodeVersion: process.version };
const result = { recordedAt: new Date().toISOString(), kind: 'local_index_microbenchmark', sourceRoot: 'packages/agent-runtime', sourceFingerprint: before, sourceStable: stable, environment, samples, medians: { coldMs: median(samples.map(item => item.coldMs)), warmMs: median(samples.map(item => item.warmMs)), restartMs: median(samples.map(item => item.restartMs)) }, limitations: ['仅同一真实源码目录的本地索引微基准，不是模型任务端到端基线', '未执行10个真实开发任务各3次', '模型首token/模型等待/token用量暂不可测量', '不能据此声称整体任务提速15%-25%'] };
await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'local-index-baseline.json'), JSON.stringify(result, null, 2), 'utf8');
await writeFile(path.join(output, 'baseline-report.md'), `# 性能基线采集（2026-11-11）\n\n结论：当前真实开发任务样本不足，不能给出端到端提速比例或Runtime排名。以下仅为真实源码目录的本地索引微基准。\n\n- 执行命令：\`npx tsx scripts/performance-baseline.ts\`。\n- 环境：${environment.platform} ${environment.release} ${environment.arch}；${environment.cpu}；${environment.logicalCpus} 逻辑CPU；${environment.memoryGiB} GiB内存；Node ${environment.nodeVersion}。\n- 源码：\`packages/agent-runtime\`，SHA256 \`${before}\`；测量期间源码${stable ? '保持一致' : '发生变化，样本不可公平比较'}。\n- 3次重复中位数：冷索引 ${result.medians.coldMs.toFixed(2)}ms，进程内增量 ${result.medians.warmMs.toFixed(2)}ms，重启后元数据复用 ${result.medians.restartMs.toFixed(2)}ms。本次每轮文件数 ${samples.map(item => item.fileCount).join('/')}；增量重新解析 ${samples.map(item => item.warmParsed).join('/')} 个文件；重启后重新解析 ${samples.map(item => item.restartParsed).join('/')} 个文件。\n- 原始样本和环境：\`local-index-baseline.json\`。计时使用 performance.now，不用系统时间差代替持续时间。\n\n## 尚缺的真实任务基线\n\n没有擅自调用收费模型或把单元测试数据冒充业务任务。需固定Runtime、Provider、模型参数、代码版本、工作区和网络，选不少于10个真实/脱敏任务，每任务运行3次。当前模型调用、网络首token、模型内部等待、Provider用量、任务验收结果均不可由本次微基准得出。\n\n## 已验证与尚未验证\n\n- 已验证：未变化文件免于重复源码解析，跨进程元数据/基础符号复用；修改单文件只重新解析受影响文件（见性能核心回归测试）。\n- 尚未验证：三个Runtime的真实业务端到端提速、95%阶段完整率、任务验收通过率和10任务对照。不应把功能可用、类型检查通过或本地快照的索引耗时等同这些目标已完成。\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
