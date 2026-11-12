-- 精工 Agent 第二轮：仅供已确认 PRAGMA user_version = 8 的数据库审阅。
-- 正常启动由 LocalStore.open 自动备份并执行增量迁移，不需要手动执行此文件。
-- 执行前必须停止应用并完整备份原数据库；若版本不是 8，请勿执行。
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

CREATE TABLE agent_task_contracts (task_id TEXT NOT NULL, session_id TEXT NOT NULL, version INTEGER NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(task_id, version));
CREATE INDEX agent_task_contracts_session ON agent_task_contracts(session_id, task_id, version);
CREATE TABLE agent_task_lifecycle_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL, session_id TEXT NOT NULL, aggregate_version INTEGER NOT NULL, previous_hash TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL);
CREATE INDEX agent_task_lifecycle_task ON agent_task_lifecycle_events(session_id, task_id, seq);
CREATE TABLE agent_task_evidence (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL);
CREATE INDEX agent_task_evidence_task ON agent_task_evidence(session_id, task_id, created_at);
CREATE TABLE verification_executions (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT, record_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL);
CREATE INDEX verification_executions_session ON verification_executions(session_id, created_at);

CREATE TRIGGER agent_task_contracts_no_update BEFORE UPDATE ON agent_task_contracts BEGIN SELECT RAISE(ABORT, 'task contracts are append-only'); END;
CREATE TRIGGER agent_task_contracts_no_delete BEFORE DELETE ON agent_task_contracts BEGIN SELECT RAISE(ABORT, 'task contracts are append-only'); END;
CREATE TRIGGER agent_task_lifecycle_no_update BEFORE UPDATE ON agent_task_lifecycle_events BEGIN SELECT RAISE(ABORT, 'task lifecycle events are append-only'); END;
CREATE TRIGGER agent_task_lifecycle_no_delete BEFORE DELETE ON agent_task_lifecycle_events BEGIN SELECT RAISE(ABORT, 'task lifecycle events are append-only'); END;
CREATE TRIGGER agent_task_evidence_no_update BEFORE UPDATE ON agent_task_evidence BEGIN SELECT RAISE(ABORT, 'task evidence is append-only'); END;
CREATE TRIGGER agent_task_evidence_no_delete BEFORE DELETE ON agent_task_evidence BEGIN SELECT RAISE(ABORT, 'task evidence is append-only'); END;
CREATE TRIGGER verification_executions_no_update BEFORE UPDATE ON verification_executions BEGIN SELECT RAISE(ABORT, 'verification executions are append-only'); END;
CREATE TRIGGER verification_executions_no_delete BEFORE DELETE ON verification_executions BEGIN SELECT RAISE(ABORT, 'verification executions are append-only'); END;

PRAGMA user_version = 10;
COMMIT;
