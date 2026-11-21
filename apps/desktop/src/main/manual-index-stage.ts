import { DatabaseSync } from 'node:sqlite';
import { buildManualChunks, tokenizeManualContent, type OperationManual, type ParsedManualDocument } from '../../../../packages/operation-manuals/src';

/** 暂存库只属于当前解析任务。工作线程无需锁定正在使用的会话数据库。 */
export function stageManualIndex(filename: string, manual: OperationManual, document: ParsedManualDocument): number {
  const chunks = buildManualChunks({ manual, blocks: document.blocks });
  const db = new DatabaseSync(filename);
  try {
    db.exec('CREATE TABLE chunks(id TEXT, hash TEXT, ordinal INTEGER, value TEXT); CREATE TABLE terms(chunk_id TEXT, term TEXT); BEGIN');
    const insertChunk = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?)');
    const insertTerm = db.prepare('INSERT INTO terms VALUES (?, ?)');
    for (const chunk of chunks) {
      insertChunk.run(chunk.id, chunk.contentHash, chunk.ordinal, JSON.stringify(chunk));
      for (const term of tokenizeManualContent(`${chunk.sectionPath.join(' ')} ${chunk.content}`).slice(0, 500)) insertTerm.run(chunk.id, term);
    }
    db.exec('COMMIT');
    return chunks.length;
  } finally { db.close(); }
}
