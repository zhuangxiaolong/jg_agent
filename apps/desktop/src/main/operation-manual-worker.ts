import { parentPort, workerData } from 'node:worker_threads';
import { parseManualFile } from '../../../../packages/operation-manuals/src/parser';
import { stageManualIndex } from './manual-index-stage';

const port = parentPort;
if (!port) throw new Error('手册解析必须在后台 Worker 中运行');

void parseManualFile(String(workerData.filename))
  .then(document => {
    const chunkCount = stageManualIndex(workerData.stagePath, workerData.manual, document);
    port.postMessage({ ok: true, document: { ...document, blocks: [] }, chunkCount });
  })
  .catch(error => port.postMessage({ ok: false, error: error instanceof Error ? error.message : '文档解析失败。' }));
