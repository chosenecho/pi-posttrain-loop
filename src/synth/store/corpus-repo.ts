import type { DatabaseSync } from "node:sqlite";
import { nonEmpty, validateSplit } from "../../shared/schema.js";
import type { DatasetSplit, QuestionMode, QuestionTaskSpec, SplitAssignMethod } from "../../shared/types.js";
import { extractVideoKey, normalizeText, nowIso, sha256Hex } from "../../shared/utils.js";
import { assertObjectJson, type MaterialRecord, type QuestionRecord, type VideoSplitRecord } from "./schema-sql.js";

export class CorpusRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly hasTable: (name: string) => boolean,
  ) {}

  getVideoSplit(videoIdOrKey: string): VideoSplitRecord | undefined {
    if (!this.hasTable("video_splits")) return undefined;
    const videoKey = extractVideoKey(nonEmpty(videoIdOrKey, "video_key"));
    return this.db.prepare(
      "SELECT video_key, split, method, salt, assigned_at FROM video_splits WHERE video_key = ?",
    ).get(videoKey) as unknown as VideoSplitRecord | undefined;
  }

  listVideoSplits(split?: DatasetSplit): VideoSplitRecord[] {
    if (!this.hasTable("video_splits")) return [];
    if (split !== undefined) {
      validateSplit(split);
      return this.db.prepare(
        "SELECT video_key, split, method, salt, assigned_at FROM video_splits WHERE split = ? ORDER BY video_key",
      ).all(split) as unknown as VideoSplitRecord[];
    }
    return this.db.prepare(
      "SELECT video_key, split, method, salt, assigned_at FROM video_splits ORDER BY video_key",
    ).all() as unknown as VideoSplitRecord[];
  }

  assignVideoSplit(input: {
    videoKey: string;
    split: DatasetSplit;
    method: SplitAssignMethod;
    salt?: string;
    assignedAt?: string;
  }): VideoSplitRecord {
    const videoKey = extractVideoKey(nonEmpty(input.videoKey, "video_key"));
    const split = validateSplit(input.split);
    const method = input.method;
    if (method !== "backfill" && method !== "hash" && method !== "manual") {
      throw new Error("split method 必须为 backfill、hash 或 manual");
    }
    const salt = nonEmpty(input.salt ?? "weimingzi-split-v1", "salt");
    const assignedAt = input.assignedAt ?? nowIso();

    this.db.prepare(`
      INSERT OR IGNORE INTO video_splits (video_key, split, method, salt, assigned_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(videoKey, split, method, salt, assignedAt);

    const record = this.getVideoSplit(videoKey);
    if (!record) throw new Error(`无法读取 video_split：${videoKey}`);
    return record;
  }

  getMaterialVideoAndSplitMap(): Map<number, { videoKey: string; videoId: string; split: DatasetSplit }> {
    const splitByVideoKey = new Map<string, DatasetSplit>();
    if (this.hasTable("video_splits")) {
      const splitRows = this.db.prepare("SELECT video_key, split FROM video_splits").all() as Array<{
        video_key: string;
        split: DatasetSplit;
      }>;
      for (const row of splitRows) {
        splitByVideoKey.set(row.video_key, row.split);
      }
    }
    const matRows = this.db.prepare("SELECT id, video_id FROM materials").all() as Array<{
      id: number;
      video_id: string;
    }>;
    const map = new Map<number, { videoKey: string; videoId: string; split: DatasetSplit }>();
    for (const row of matRows) {
      const videoKey = extractVideoKey(row.video_id);
      const split = splitByVideoKey.get(videoKey) ?? "train";
      map.set(Number(row.id), { videoKey, videoId: row.video_id, split });
    }
    return map;
  }

  upsertMaterial(input: { videoId: string; content: string; sourcePath?: string | null; createdAt?: string }): MaterialRecord {
    const videoId = nonEmpty(input.videoId, "video_id");
    const content = normalizeText(input.content);
    nonEmpty(content, "material content");
    const sha256 = sha256Hex(content);
    const createdAt = input.createdAt ?? nowIso();
    const sourcePath = input.sourcePath ?? null;

    this.db.prepare(`
      INSERT OR IGNORE INTO materials (video_id, content, sha256, source_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(videoId, content, sha256, sourcePath, createdAt);

    const row = this.db.prepare(`
      SELECT id, video_id, content, sha256, source_path, created_at
      FROM materials
      WHERE video_id = ? AND sha256 = ?
    `).get(videoId, sha256) as unknown as MaterialRecord | undefined;
    if (!row) throw new Error(`无法读取材料记录：${videoId}`);
    return row;
  }

  insertQuestion(input: {
    id?: number;
    materialId: number;
    question: string;
    generationRunId?: number | null;
    questionMode?: QuestionMode;
    taskSpec?: QuestionTaskSpec | null;
    createdAt?: string;
  }): { record: QuestionRecord; inserted: boolean } {
    const question = nonEmpty(input.question, "question");
    const createdAt = input.createdAt ?? nowIso();
    const generationRunId = input.generationRunId ?? null;
    const questionMode: QuestionMode = input.questionMode ?? "direct";
    if (questionMode !== "direct" && questionMode !== "todo_plan" && questionMode !== "clarify_question") {
      throw new Error(`无效的 questionMode：${String(questionMode)}`);
    }
    const taskSpecJson = input.taskSpec !== undefined && input.taskSpec !== null
      ? assertObjectJson(input.taskSpec, "taskSpec")
      : null;

    const existing = this.db.prepare(`
      SELECT id, material_id, question, generation_run_id, question_mode, task_spec_json, created_at
      FROM questions
      WHERE material_id = ? AND question = ?
    `).get(input.materialId, question) as unknown as QuestionRecord | undefined;

    if (existing) {
      if (input.id !== undefined && existing.id !== input.id) {
        throw new Error(`问题已存在但 ID 不一致：期望 ${input.id}，实际 ${existing.id}`);
      }
      return { record: existing, inserted: false };
    }

    let insertedId: number;
    if (input.id !== undefined) {
      if (!Number.isSafeInteger(input.id) || input.id < 1) throw new Error("问题 ID 必须是正整数");
      this.db.prepare(`
        INSERT INTO questions (id, material_id, question, generation_run_id, question_mode, task_spec_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.id, input.materialId, question, generationRunId, questionMode, taskSpecJson, createdAt);
      insertedId = input.id;
    } else {
      const info = this.db.prepare(`
        INSERT INTO questions (material_id, question, generation_run_id, question_mode, task_spec_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.materialId, question, generationRunId, questionMode, taskSpecJson, createdAt);
      insertedId = Number(info.lastInsertRowid);
    }

    const record = this.db.prepare(`
      SELECT id, material_id, question, generation_run_id, question_mode, task_spec_json, created_at
      FROM questions WHERE id = ?
    `).get(insertedId) as unknown as QuestionRecord;
    return { record, inserted: true };
  }

  listProcessedVideoRows(profile?: string): Array<{ video_id: string; sha256: string }> {
    if (profile !== undefined) {
      const normalized = profile.trim().toLowerCase();
      return this.db.prepare(`
        SELECT DISTINCT m.video_id, m.sha256
        FROM materials m
        WHERE EXISTS (
          SELECT 1
          FROM questions q
          LEFT JOIN runs r ON r.id = q.generation_run_id
          WHERE q.material_id = m.id
            AND LOWER(COALESCE(json_extract(r.config_json, '$.profile'), 'standard')) = ?
        ) OR EXISTS (
          SELECT 1
          FROM model_calls c
          JOIN runs r ON r.id = c.run_id
          WHERE c.material_id = m.id
            AND c.role = 'question'
            AND c.status = 'completed'
            AND LOWER(COALESCE(json_extract(r.config_json, '$.profile'), 'standard')) = ?
        )
      `).all(normalized, normalized) as Array<{ video_id: string; sha256: string }>;
    }
    return this.db.prepare(`
      SELECT DISTINCT m.video_id, m.sha256
      FROM materials m
      WHERE EXISTS (SELECT 1 FROM questions q WHERE q.material_id = m.id)
         OR EXISTS (
           SELECT 1 FROM model_calls c
           WHERE c.material_id = m.id
             AND c.role = 'question'
             AND c.status = 'completed'
         )
    `).all() as Array<{ video_id: string; sha256: string }>;
  }

  listMaterialIndex(): Array<{ id: number; video_id: string; sha256: string }> {
    return this.db.prepare("SELECT id, video_id, sha256 FROM materials").all() as Array<{
      id: number;
      video_id: string;
      sha256: string;
    }>;
  }

  listAllMaterials(): Array<{ id: number; video_id: string; content: string; sha256: string; source_path: string | null }> {
    return this.db.prepare(
      "SELECT id, video_id, content, sha256, source_path FROM materials ORDER BY id",
    ).all() as Array<{ id: number; video_id: string; content: string; sha256: string; source_path: string | null }>;
  }

  getMaterialSha256(materialId: number): string | undefined {
    const row = this.db.prepare("SELECT sha256 FROM materials WHERE id = ?").get(materialId) as
      | { sha256: string }
      | undefined;
    return row?.sha256;
  }

  listQuestionIdsForMaterialRun(materialId: number, generationRunId: number): number[] {
    const rows = this.db.prepare(
      "SELECT id FROM questions WHERE material_id = ? AND generation_run_id = ? ORDER BY id",
    ).all(materialId, generationRunId) as Array<{ id: number }>;
    return rows.map((r) => Number(r.id));
  }

  listAllQuestionsWithVideoId(): Array<{ question: string; video_id: string }> {
    return this.db.prepare(`
      SELECT q.question, m.video_id
      FROM questions q
      JOIN materials m ON m.id = q.material_id
    `).all() as Array<{ question: string; video_id: string }>;
  }

  queryQuestionCountsByVideo(): Array<{ video_id: string; q_count: number }> {
    return this.db.prepare(`
      SELECT m.video_id, COUNT(q.id) AS q_count
      FROM questions q
      JOIN materials m ON m.id = q.material_id
      GROUP BY m.video_id
    `).all() as Array<{ video_id: string; q_count: number }>;
  }

  queryPassedResultCountsByVideo(): Array<{ video_id: string; pass_count: number }> {
    return this.db.prepare(`
      SELECT m.video_id, COUNT(DISTINCT i.question_id) AS pass_count
      FROM results r
      JOIN run_items i ON i.id = r.run_item_id
      JOIN questions q ON q.id = i.question_id
      JOIN materials m ON m.id = q.material_id
      GROUP BY m.video_id
    `).all() as Array<{ video_id: string; pass_count: number }>;
  }
}
