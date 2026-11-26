import type { DatabaseSync } from "node:sqlite";
import { nowIso, sha256Hex, type ProbeType, type Row, type SourceMaterialRecord } from "./types.js";

function mapSource(row: Row): SourceMaterialRecord {
  return {
    id: Number(row.id),
    videoId: String(row.video_id),
    videoKey: String(row.video_key),
    mainMaterialId: row.main_material_id === null ? null : Number(row.main_material_id),
    partCount: Number(row.part_count),
    content: String(row.content),
    contentSha256: String(row.content_sha256),
    sourcePath: row.source_path === null ? null : String(row.source_path),
    importedAt: String(row.imported_at),
  };
}

export class EvalSourceRepository {
  constructor(private readonly db: DatabaseSync) {}

  insertSourceMaterial(input: {
    videoId: string;
    videoKey: string;
    mainMaterialId?: number | null;
    partCount: number;
    content: string;
    sourcePath?: string | null;
    splitSnapshot: string;
  }): { record: SourceMaterialRecord; created: boolean } {
    if (input.splitSnapshot !== "test") {
      throw new Error(`评测库只接受 test 分区材料：${input.videoKey} 实际为 ${input.splitSnapshot}`);
    }
    const contentSha256 = sha256Hex(input.content);
    const existing = this.getSourceMaterialByVideoId(input.videoId);
    if (existing) {
      if (existing.contentSha256 !== contentSha256) {
        throw new Error(`材料快照 ${input.videoId} 已存在且内容不同（sha256 ${existing.contentSha256.slice(0, 12)}），禁止覆盖`);
      }
      return { record: existing, created: false };
    }
    this.db.prepare(`
      INSERT INTO source_materials (video_id, video_key, main_material_id, split_snapshot, part_count, content, content_sha256, source_path, imported_at)
      VALUES (?, ?, ?, 'test', ?, ?, ?, ?, ?)
    `).run(
      input.videoId,
      input.videoKey,
      input.mainMaterialId ?? null,
      input.partCount,
      input.content,
      contentSha256,
      input.sourcePath ?? null,
      nowIso(),
    );
    const record = this.getSourceMaterialByVideoId(input.videoId);
    if (!record) throw new Error(`无法读取材料快照：${input.videoId}`);
    return { record, created: true };
  }

  getSourceMaterialByVideoId(videoId: string): SourceMaterialRecord | undefined {
    const row = this.db.prepare("SELECT * FROM source_materials WHERE video_id = ?").get(videoId) as Row | undefined;
    return row ? mapSource(row) : undefined;
  }

  getSourceMaterial(id: number): SourceMaterialRecord | undefined {
    const row = this.db.prepare("SELECT * FROM source_materials WHERE id = ?").get(id) as Row | undefined;
    return row ? mapSource(row) : undefined;
  }

  listSourceMaterials(): SourceMaterialRecord[] {
    return (this.db.prepare("SELECT * FROM source_materials ORDER BY id").all() as Row[]).map(mapSource);
  }

  /** Source materials that have never been used by any probe_build run (optionally scoped to probeTypes). */
  listUnbuiltSourceMaterials(probeTypes?: readonly ProbeType[]): SourceMaterialRecord[] {
    if (probeTypes && probeTypes.length > 0) {
      const placeholders = probeTypes.map(() => "?").join(", ");
      return (this.db.prepare(`
        SELECT * FROM source_materials m
        WHERE NOT EXISTS (
          SELECT 1 FROM probe_specs s
          WHERE s.source_material_id = m.id
            AND s.probe_type IN (${placeholders})
        )
        ORDER BY id
      `).all(...probeTypes) as Row[]).map(mapSource);
    }
    return (this.db.prepare(`
      SELECT * FROM source_materials m
      WHERE NOT EXISTS (SELECT 1 FROM probe_specs s WHERE s.source_material_id = m.id)
      ORDER BY id
    `).all() as Row[]).map(mapSource);
  }

  listSourceMaterialsByVideoKeys(videoKeys: string[]): SourceMaterialRecord[] {
    if (videoKeys.length === 0) return [];
    const placeholders = videoKeys.map(() => "?").join(", ");
    return (this.db.prepare(`
      SELECT * FROM source_materials
      WHERE video_key IN (${placeholders}) OR video_id IN (${placeholders})
      ORDER BY id
    `).all(...videoKeys, ...videoKeys) as Row[]).map(mapSource);
  }

  /**
   * Returns existing turn-1 questions for a videoKey across frozen suites (e.g. indist-v1)
   * and non-rejected probes, used for semantic deduplication.
   */
  listExistingQuestionsForVideoKey(videoKey: string): string[] {
    const questions: string[] = [];
    const probeRows = this.db.prepare(`
      SELECT p.question
      FROM probes p
      JOIN probe_specs s ON s.id = p.spec_id
      JOIN source_materials m ON m.id = s.source_material_id
      WHERE m.video_key = ? AND p.status != 'rejected'
    `).all(videoKey) as Row[];
    for (const row of probeRows) {
      questions.push(String(row.question));
    }
    const suiteRows = this.db.prepare(`
      SELECT messages_json FROM suite_items WHERE video_key = ?
    `).all(videoKey) as Row[];
    for (const row of suiteRows) {
      try {
        const messages = JSON.parse(String(row.messages_json)) as Array<{ role?: string; content?: string }>;
        const firstUser = messages.find((m) => m.role === "user" && typeof m.content === "string");
        if (firstUser?.content) questions.push(firstUser.content);
      } catch {
        // Ignore malformed messages_json
      }
    }
    return questions;
  }

  listEvalVideoKeys(): Set<string> {
    const keys = new Set<string>();
    for (const row of this.db.prepare("SELECT DISTINCT video_key FROM source_materials").all() as Row[]) {
      keys.add(String(row.video_key));
    }
    for (const row of this.db.prepare("SELECT DISTINCT video_key FROM suite_items").all() as Row[]) {
      keys.add(String(row.video_key));
    }
    return keys;
  }

  countSummary(): { sourceMaterials: number; unbuiltSourceMaterials: number; sourceVideoKeys: number } {
    const sourceMaterials = Number((this.db.prepare("SELECT count(*) AS c FROM source_materials").get() as Row).c);
    const unbuiltSourceMaterials = Number((this.db.prepare(
      "SELECT count(*) AS c FROM source_materials m WHERE NOT EXISTS (SELECT 1 FROM probe_specs s WHERE s.source_material_id = m.id)",
    ).get() as Row).c);
    const sourceVideoKeys = Number((this.db.prepare("SELECT count(DISTINCT video_key) AS c FROM source_materials").get() as Row).c);
    return { sourceMaterials, unbuiltSourceMaterials, sourceVideoKeys };
  }
}
