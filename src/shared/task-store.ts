import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { PublicError } from "./public-error.js";

const liveSessions = new Set<TaskSession>();
const onInterrupt = () => {
  process.exitCode = 130;
  for (const session of liveSessions) session.abort(new PublicError("operation_aborted"));
};
const onTerminate = () => {
  process.exitCode = 143;
  for (const session of liveSessions) session.abort(new PublicError("operation_aborted"));
};
function trackSession(session: TaskSession): void {
  if (liveSessions.size === 0) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  }
  liveSessions.add(session);
}
function untrackSession(session: TaskSession): void {
  liveSessions.delete(session);
  if (liveSessions.size === 0) {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

interface TaskOwner {
  owner_token: string;
  hostname: string;
  pid: number;
  task_kind: string;
  acquired_at: string;
}

export class DatabaseTaskError extends Error {
  constructor(readonly code: "database_busy" | "database_owner_lost" | "async_transaction", owner?: TaskOwner) {
    super(owner
      ? `数据库已有写任务 [${code}] (${owner.task_kind}, PID ${owner.pid}, ${owner.acquired_at})`
      : `数据库写会话异常 [${code}]`);
    this.name = "DatabaseTaskError";
  }
}

function processIsDefinitelyGone(owner: TaskOwner): boolean {
  if (owner.hostname !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** One local writer per physical SQLite database. Ownership never expires by time. */
export class TaskSession {
  readonly ownerToken = randomUUID();
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private sequence = 0;
  private released = false;

  constructor(private readonly db: DatabaseSync, taskKind: string) {
    this.signal = this.controller.signal;
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec(`CREATE TABLE IF NOT EXISTS runtime_task_lock (
        lock_key TEXT PRIMARY KEY CHECK(lock_key = 'writer'),
        owner_token TEXT NOT NULL,
        hostname TEXT NOT NULL,
        pid INTEGER NOT NULL,
        task_kind TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      )`);
      const owner = db.prepare("SELECT * FROM runtime_task_lock WHERE lock_key = 'writer'").get() as TaskOwner | undefined;
      if (owner && !processIsDefinitelyGone(owner)) throw new DatabaseTaskError("database_busy", owner);
      db.prepare(`INSERT INTO runtime_task_lock
        (lock_key, owner_token, hostname, pid, task_kind, acquired_at)
        VALUES ('writer', ?, ?, ?, ?, ?)
        ON CONFLICT(lock_key) DO UPDATE SET owner_token=excluded.owner_token,
          hostname=excluded.hostname, pid=excluded.pid, task_kind=excluded.task_kind,
          acquired_at=excluded.acquired_at`)
        .run(this.ownerToken, hostname(), process.pid, taskKind, new Date().toISOString());
      db.exec("COMMIT");
      trackSession(this);
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      if (error && typeof error === "object" && "errcode" in error && Number(error.errcode) === 5) throw new DatabaseTaskError("database_busy");
      throw error;
    }
  }

  /** Owner check and writes share one synchronous transaction; nested operations use savepoints. */
  mutate<T>(operation: () => T): T {
    if (this.released) throw new DatabaseTaskError("database_owner_lost");
    if (operation.constructor.name === "AsyncFunction") throw new DatabaseTaskError("async_transaction");
    const nested = this.db.isTransaction;
    const savepoint = `task_${++this.sequence}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    try {
      const owner = this.db.prepare("SELECT owner_token FROM runtime_task_lock WHERE lock_key = 'writer'").get() as { owner_token: string } | undefined;
      if (owner?.owner_token !== this.ownerToken) throw new DatabaseTaskError("database_owner_lost");
      const result = operation();
      if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) {
        // The operation has already been invoked: consume a possible rejection, but roll back all synchronous writes.
        void Promise.resolve(result).catch(() => undefined);
        throw new DatabaseTaskError("async_transaction");
      }
      this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK");
      if (nested) this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  abort(reason?: unknown): void { this.controller.abort(reason); }

  release(): void {
    if (this.released) return;
    try {
      this.mutate(() => {
        this.db.prepare("DELETE FROM runtime_task_lock WHERE lock_key = 'writer' AND owner_token = ?").run(this.ownerToken);
      });
    } finally {
      this.released = true;
      untrackSession(this);
      this.controller.abort();
    }
  }
}

/** Incremental metadata columns shared by domain constructors; called after ownership is acquired. */
export function ensureRunOwnerColumn(db: DatabaseSync, table: string): void {
  if (!["runs", "reasoning_runs", "probe_runs", "eval_runs"].includes(table)) throw new Error("Unknown run table");
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.length && !columns.some((column) => column.name === "owner_token")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN owner_token TEXT`);
  }
}
