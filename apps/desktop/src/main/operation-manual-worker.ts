import { parentPort, workerData } from 'node:worker_threads';
import { parseManualFile } from '../../../../packages/operation-manuals/src/parser';

const port = parentPort;
if (!port) throw new Error('手册解析必须在后台 Worker 中运行');

void parseManualFile(String(workerData.filename))
  .then(document => port.postMessage({ ok: true, document }))
  .catch(error => port.postMessage({ ok: false, error: error instanceof Error ? error.message : '文档解析失败。' }));
