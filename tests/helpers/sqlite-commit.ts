import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

/** 回滚日志模式下允许事务写入，另一个读事务会阻止最终提交。 */
export function assertCommitBlocked(filename: string, write: () => void): void {
  const reader = new DatabaseSync(filename, { readOnly: true });
  try {
    reader.exec('BEGIN; SELECT count(*) FROM sqlite_schema');
    assert.throws(write, /database is locked/);
  } finally { reader.close(); }
}
