import type { DatabaseSync } from "node:sqlite";
import { nonEmpty } from "../../shared/schema.js";
import { extractVideoKey, nowIso, sha256Hex } from "../../shared/utils.js";
import {
  parseJsonArray,
  parseJsonObject,
  type InsertSourceMaterialInput,
  type ProbeRunKind,
  type ProbeRunRecord,
  type RunLifecycleStatus,
  type SourceMaterialRecord,
  type StartAgentCallInput,
} from "./types.js";

function mapSourceRow(row: Record<string, unknown>): SourceMaterialRecord {
  return {
    id: Number(row.id),
    videoId: String(row.video_id),
    videoKey: String(row.video_key),
    mainMaterialId: row.main_material_id === null ? null : Number(row.main_material_id),
    partCount: Number(row.part_count),
    content: String(row.content),
    contentSha256: String(row.content_sha256),
    sourcePath: row.source_path === null ? null : String(row.source_path),
    splitSnapshot: String(row.split_snapshot),
    importedAt: String(row.imported_at),
  };
}

function mapProbeRunRow(row: Record<string, unknown>): ProbeRunRecord {
  return {
    id: Number(row.id),
    kind: String(row.kind) as ProbeRunKind,
    status: String(row.status) as RunLifecycleStatus,
    config: parseJsonObject(String(row.config_json)),
    prompts: parseJsonObject(String(row.prompts_json)),
    skills: parseJsonArray(String(row.skills_json)),
    startedAt: String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    error: row.error === null ? null : String(row.error),
  };
}

export class EvalSourceRepo {
  constructor(private readonly db: DatabaseSync) {}

  insertSourceMaterial(input: InsertSourceMaterialInput): { created: boolean; record: SourceMaterialRecord } {
    const videoId = nonEmpty(input.videoId, "videoId");
    const videoKey = input.videoKey ? nonEmpty(input.videoKey, "videoKey") : extractVideoKey(videoId);
    const content = nonEmpty(input.content, "content");
    const splitSnapshot = input.splitSnapshot ?? "test";
    if (splitSnapshot !== "test") {
      throw new Error(`评测库 source_materials 仅允许导入 split='test'，收到：${splitSnapshot}`);
    }
    const contentSha256 = sha256Hex(content);
    const existing = this.db
      .prepare("SELECT * FROM source_materials WHERE video_id = ? AND content_sha256 = ?")
      .get(videoId, contentSha256) as Record<string, unknown> | undefined;
    if (existing) {
      return { created: false, record: mapSourceRow(existing) };
    }
    const result = this.db
      .prepare(
        `INSERT INTO source_materials
         (video_id, video_key, main_material_id, part_count, content, content_sha256, source_path, split_snapshot, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'test', ?)`,
      )
      .run(
        videoId,
        videoKey,
        input.mainMaterialId ?? null,
        input.partCount ?? 1,
        content,
        contentSha256,
        input.sourcePath ?? null,
        nowIso(),
      );
    const row = this.db
      .prepare("SELECT * FROM source_materials WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as Record<string, unknown>;
    return { created: true, record: mapSourceRow(row) };
  }

  getSourceMaterial(id: number): SourceMaterialRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM source_materials WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapSourceRow(row) : undefined;
  }

  listSourceMaterials(filter: { videoKeys?: string[]; limit?: number } = {}): SourceMaterialRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.videoKeys && filter.videoKeys.length > 0) {
      const normalized = [...new Set(filter.videoKeys.map((k) => extractVideoKey(k)))];
      clauses.push(`video_key IN (${normalized.map(() => "?").join(", ")})`);
      params.push(...normalized);
    }
    let sql = "SELECT * FROM source_materials";
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY id ASC";
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapSourceRow);
  }

  /** Latest generation decides pending work; legacy probes alone never prove batch completeness. */
  listUnbuiltSourceMaterials(filter: { videoKeys?: string[]; limit?: number } = {}): SourceMaterialRecord[] {
    const clauses: string[] = [
      `NOT EXISTS (SELECT 1 FROM probe_build_plans p WHERE p.source_material_id = s.id
       AND p.generation = (SELECT max(n.generation) FROM probe_build_plans n WHERE n.source_material_id = s.id)
       AND p.plan_complete = 1 AND p.status IN ('done', 'skipped'))`,
    ];
    const params: Array<string | number> = [];
    if (filter.videoKeys && filter.videoKeys.length > 0) {
      const normalized = [...new Set(filter.videoKeys.map((k) => extractVideoKey(k)))];
      clauses.push(`s.video_key IN (${normalized.map(() => "?").join(", ")})`);
      params.push(...normalized);
    }
    let sql = `SELECT s.* FROM source_materials s WHERE ${clauses.join(" AND ")} ORDER BY s.id ASC`;
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapSourceRow);
  }

  listEvalVideoKeys(): Set<string> {
    const keys = new Set<string>();
    for (const row of this.db.prepare("SELECT DISTINCT video_key FROM source_materials").all() as Array<{ video_key: string }>) {
      keys.add(row.video_key);
    }
    for (const row of this.db.prepare("SELECT DISTINCT video_key FROM suite_items").all() as Array<{ video_key: string }>) {
      keys.add(row.video_key);
    }
    return keys;
  }

  createRun(input: {
    kind: ProbeRunKind;
    config: Record<string, unknown>;
    prompts: Record<string, unknown>;
    skills: unknown[];
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO probe_runs (kind, status, config_json, prompts_json, skills_json, started_at)
         VALUES (?, 'running', ?, ?, ?, ?)`,
      )
      .run(input.kind, JSON.stringify(input.config), JSON.stringify(input.prompts), JSON.stringify(input.skills), nowIso());
    return Number(res.lastInsertRowid);
  }

  finishRun(runId: number, status: Exclude<RunLifecycleStatus, "running">, error?: string): void {
    this.db
      .prepare("UPDATE probe_runs SET status = ?, ended_at = ?, error = ? WHERE id = ?")
      .run(status, nowIso(), error ?? null, runId);
  }

  getRun(runId: number): ProbeRunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM probe_runs WHERE id = ?").get(runId) as Record<string, unknown> | undefined;
    return row ? mapProbeRunRow(row) : undefined;
  }

  getLatestRun(kind: ProbeRunKind): ProbeRunRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM probe_runs WHERE kind = ? ORDER BY id DESC LIMIT 1")
      .get(kind) as Record<string, unknown> | undefined;
    return row ? mapProbeRunRow(row) : undefined;
  }

  listActiveRuns(kinds?: readonly ProbeRunKind[]): ProbeRunRecord[] {
    if (kinds && kinds.length > 0) {
      const rows = this.db
        .prepare(`SELECT * FROM probe_runs WHERE status = 'running' AND kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY id ASC`)
        .all(...kinds) as Array<Record<string, unknown>>;
      return rows.map(mapProbeRunRow);
    }
    const rows = this.db
      .prepare("SELECT * FROM probe_runs WHERE status = 'running' ORDER BY id ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapProbeRunRow);
  }

  startCall(input: StartAgentCallInput): number {
    const res = this.db
      .prepare(
        `INSERT INTO agent_calls (run_ref, role, model, input_refs_json, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.runRef, input.role, input.model, JSON.stringify(input.inputRefs), nowIso());
    return Number(res.lastInsertRowid);
  }

  finishCall(callId: number, outcome: { output?: string; error?: string }): void {
    this.db
      .prepare("UPDATE agent_calls SET output_text = ?, error = ?, ended_at = ? WHERE id = ?")
      .run(outcome.output ?? null, outcome.error ?? null, nowIso(), callId);
  }

  getAgentCall(callId: number): { id: number; output: string | null; error: string | null; inputRefs: Record<string, unknown> } | undefined {
    const row = this.db.prepare("SELECT * FROM agent_calls WHERE id = ?").get(callId);
    return row ? { id: Number(row.id), output: row.output_text === null ? null : String(row.output_text), error: row.error === null ? null : String(row.error), inputRefs: parseJsonObject(String(row.input_refs_json)) } : undefined;
  }

  countAgentCalls(runRef: string, role?: string): number {
    if (role) {
      const row = this.db
        .prepare("SELECT count(*) AS c FROM agent_calls WHERE run_ref = ? AND role = ?")
        .get(runRef, role) as { c: number };
      return Number(row.c);
    }
    const row = this.db
      .prepare("SELECT count(*) AS c FROM agent_calls WHERE run_ref = ?")
      .get(runRef) as { c: number };
    return Number(row.c);
  }
}
