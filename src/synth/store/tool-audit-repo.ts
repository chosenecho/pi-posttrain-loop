import type { DatabaseSync } from "node:sqlite";
import type { ToolAttempt } from "../../shared/types.js";
import { nowIso } from "../../shared/utils.js";

/** Runtime audit stays separate from successful training tool steps. The store supplies ownership. */
export class ToolAuditRepository {
  constructor(private readonly db: DatabaseSync) {}

  record(modelCallId: number, attempt: Readonly<ToolAttempt>): void {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO tool_attempt_audit
        (model_call_id, attempt_id, batch_id, tool_call_id, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model_call_id, attempt_id, batch_id, tool_call_id) DO UPDATE SET
        status = excluded.status, payload_json = excluded.payload_json, updated_at = excluded.updated_at
      WHERE excluded.status <> 'attempted' OR tool_attempt_audit.status = 'attempted'
    `).run(modelCallId, attempt.attemptId, attempt.batchId, attempt.toolCallId,
      attempt.status, JSON.stringify(attempt), timestamp, timestamp);
  }

  list(modelCallId: number): ToolAttempt[] {
    const rows = this.db.prepare(`
      SELECT payload_json FROM tool_attempt_audit WHERE model_call_id = ? ORDER BY id
    `).all(modelCallId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as ToolAttempt);
  }
}
