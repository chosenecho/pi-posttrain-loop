import type { DatabaseSync } from "node:sqlite";
import { nonEmpty, validateMaxTurns, validateSplit } from "../../shared/schema.js";
import type { DatasetSplit, TrainingMessage, TrainingSampleLine } from "../../shared/types.js";
import { createSeededRng, nowIso, sha256Hex, shuffleInPlace } from "../../shared/utils.js";
import type { CorpusRepository } from "./corpus-repo.js";
import type { RunRepository } from "./run-repo.js";
import {
  formatSamplesJsonl,
  type DedupPolicy,
  type ExportOptions,
  type MergedExportOptions,
  type MergedExportRecord,
  type MergedExportResult,
  type ResultTurnRow,
  type TestSetVersionRecord,
} from "./schema-sql.js";

export class ExportRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly hasTable: (name: string) => boolean,
    private readonly corpus: CorpusRepository,
    private readonly runs: RunRepository,
  ) {}

  exportRunSamples(runId: number, options: ExportOptions = {}): TrainingSampleLine[] {
    const rows = this.runs.queryResultTurns(runId);
    const systemPrompt = options.systemPrompt !== undefined ? nonEmpty(options.systemPrompt, "systemPrompt") : undefined;
    const grouped = new Map<number, ResultTurnRow[]>();
    for (const row of rows) {
      const list = grouped.get(row.result_id);
      if (list) list.push(row);
      else grouped.set(row.result_id, [row]);
    }
    const samples: TrainingSampleLine[] = [];
    for (const turns of grouped.values()) {
      const messages: TrainingMessage[] = [];
      if (systemPrompt !== undefined) {
        messages.push({ role: "system", content: systemPrompt });
      }
      for (const turn of turns) {
        messages.push({ role: "user", content: turn.user_content });
        messages.push({ role: "assistant", content: turn.assistant_content });
      }
      samples.push({ messages });
    }
    return samples;
  }

  exportRunJsonl(runId: number, options: ExportOptions = {}): string {
    return formatSamplesJsonl(this.exportRunSamples(runId, options));
  }

  exportMergedDataset(options: MergedExportOptions): MergedExportResult {
    const hasVersion = options.versionName !== undefined;
    const hasRunIds = options.runIds !== undefined && options.runIds.length > 0;
    const allFormal = Boolean(options.allFormal);
    if (!hasVersion) {
      if (hasRunIds && allFormal) {
        throw new Error("runIds 与 allFormal 不能同时指定");
      }
      if (!hasRunIds && !allFormal) {
        throw new Error("必须指定 runIds、allFormal 或 versionName");
      }
    }
    const targetSplit = options.split !== undefined ? validateSplit(options.split) : undefined;
    const dedup: DedupPolicy = options.dedup ?? "latest";
    if (dedup !== "latest" && dedup !== "earliest" && dedup !== "error") {
      throw new Error("dedup 必须为 latest、earliest 或 error");
    }
    if (options.minTurns !== undefined) validateMaxTurns(options.minTurns);
    if (options.maxTurns !== undefined) validateMaxTurns(options.maxTurns);
    if (options.minTurns !== undefined && options.maxTurns !== undefined && options.minTurns > options.maxTurns) {
      throw new Error("minTurns 不能大于 maxTurns");
    }
    if (options.valRatio !== undefined && (!Number.isFinite(options.valRatio) || options.valRatio <= 0 || options.valRatio >= 1)) {
      throw new Error("valRatio 必须是 (0, 1) 之间的小数");
    }

    const systemPrompt = options.systemPrompt !== undefined ? nonEmpty(options.systemPrompt, "systemPrompt") : undefined;
    const excludeSet = new Set(options.excludeRunIds ?? []);
    const materialInfo = this.corpus.getMaterialVideoAndSplitMap();

    let rows: ResultTurnRow[];
    if (hasVersion) {
      const version = this.getTestSetVersion(nonEmpty(options.versionName, "versionName"));
      if (!version) throw new Error(`未找到测试集版本：${options.versionName}`);
      if (targetSplit !== undefined && version.split !== targetSplit) {
        throw new Error(`版本 ${version.name} 属于 ${version.split} 分区，与请求的 --split ${targetSplit} 不一致`);
      }
      const resultIds = JSON.parse(version.result_ids_json) as number[];
      if (resultIds.length === 0) {
        return {
          train: [], val: [], includedRunIds: [], countsByRunId: {}, turnCountDistribution: {},
          duplicateQuestionsResolved: 0, materialCount: 0, trainMaterialCount: 0, valMaterialCount: 0,
        };
      }
      const placeholders = resultIds.map(() => "?").join(", ");
      rows = this.db.prepare(`
        SELECT r.id AS result_id,
               i.run_id,
               q.id AS question_id,
               q.material_id,
               r.turn_count,
               t.turn_no,
               COALESCE(t.user_content, q.question) AS user_content,
               a.answer AS assistant_content,
               a.attempt_no
        FROM results r
        JOIN run_items i ON i.id = r.run_item_id
        JOIN questions q ON q.id = i.question_id
        JOIN turns t ON t.run_item_id = i.id
        JOIN attempts a ON a.id = t.passed_attempt_id
        WHERE r.id IN (${placeholders})
        ORDER BY i.run_id, q.id, t.turn_no
      `).all(...resultIds) as unknown as ResultTurnRow[];
    } else {
      let candidateRunIds: number[];
      if (allFormal) {
        const effectiveSplit = targetSplit ?? "train";
        const runRows = effectiveSplit === "train"
          ? (this.db.prepare(`
              SELECT id FROM runs
              WHERE kind = 'answer_judge'
                AND json_extract(export_policy_json, '$.training_enabled') = 1
                AND COALESCE(json_extract(export_policy_json, '$.split'), 'train') = 'train'
              ORDER BY id
            `).all() as Array<{ id: number }>)
          : (this.db.prepare(`
              SELECT id FROM runs
              WHERE kind = 'answer_judge'
                AND (
                  json_extract(export_policy_json, '$.eval_enabled') = 1
                  OR json_extract(export_policy_json, '$.training_enabled') = 1
                  OR json_extract(export_policy_json, '$.split') = ?
                )
              ORDER BY id
            `).all(effectiveSplit) as Array<{ id: number }>);
        candidateRunIds = runRows.map((r) => Number(r.id)).filter((id) => !excludeSet.has(id));
      } else {
        const requested = [...new Set(options.runIds!)];
        for (const id of requested) {
          if (!Number.isSafeInteger(id) || id < 1) throw new Error(`无效的 run_id：${id}`);
          const exists = this.db.prepare("SELECT id, kind FROM runs WHERE id = ?").get(id) as { id: number; kind: string } | undefined;
          if (!exists) throw new Error(`未找到 run_id=${id}`);
          if (exists.kind !== "answer_judge") throw new Error(`run_id=${id} 不是 answer_judge 运行（kind=${exists.kind}）`);
        }
        candidateRunIds = requested.filter((id) => !excludeSet.has(id));
      }

      if (candidateRunIds.length === 0) {
        return {
          train: [],
          val: [],
          includedRunIds: [],
          countsByRunId: {},
          turnCountDistribution: {},
          duplicateQuestionsResolved: 0,
          materialCount: 0,
          trainMaterialCount: 0,
          valMaterialCount: 0,
        };
      }

      const placeholders = candidateRunIds.map(() => "?").join(", ");
      const params: number[] = [...candidateRunIds];
      let sql = `
        SELECT r.id AS result_id,
               i.run_id,
               q.id AS question_id,
               q.material_id,
               r.turn_count,
               t.turn_no,
               COALESCE(t.user_content, q.question) AS user_content,
               a.answer AS assistant_content,
               a.attempt_no
        FROM results r
        JOIN run_items i ON i.id = r.run_item_id
        JOIN questions q ON q.id = i.question_id
        JOIN turns t ON t.run_item_id = i.id
        JOIN attempts a ON a.id = t.passed_attempt_id
        WHERE i.run_id IN (${placeholders})
      `;
      if (options.minTurns !== undefined) {
        sql += " AND r.turn_count >= ?";
        params.push(options.minTurns);
      }
      if (options.maxTurns !== undefined) {
        sql += " AND r.turn_count <= ?";
        params.push(options.maxTurns);
      }
      sql += " ORDER BY i.run_id, q.id, t.turn_no";

      rows = this.db.prepare(sql).all(...params) as unknown as ResultTurnRow[];
    }

    const effectiveSplitFilter: DatasetSplit | undefined = hasVersion
      ? undefined
      : (targetSplit ?? (allFormal ? "train" : undefined));

    const groupedByResult = new Map<number, ResultTurnRow[]>();
    for (const row of rows) {
      if (effectiveSplitFilter !== undefined) {
        const matSplit = materialInfo.get(Number(row.material_id))?.split ?? "train";
        if (matSplit !== effectiveSplitFilter) continue;
      }
      if (hasVersion) {
        if (options.minTurns !== undefined && Number(row.turn_count) < options.minTurns) continue;
        if (options.maxTurns !== undefined && Number(row.turn_count) > options.maxTurns) continue;
      }
      const list = groupedByResult.get(row.result_id);
      if (list) list.push(row);
      else groupedByResult.set(row.result_id, [row]);
    }

    const byQuestion = new Map<number, MergedExportRecord[]>();
    for (const turns of groupedByResult.values()) {
      const first = turns[0];
      const messages: TrainingMessage[] = [];
      if (systemPrompt !== undefined) {
        messages.push({ role: "system", content: systemPrompt });
      }
      for (const turn of turns) {
        messages.push({ role: "user", content: turn.user_content });
        messages.push({ role: "assistant", content: turn.assistant_content });
      }
      const record: MergedExportRecord = {
        resultId: Number(first.result_id),
        runId: Number(first.run_id),
        questionId: Number(first.question_id),
        materialId: Number(first.material_id),
        turnCount: Number(first.turn_count),
        sample: { messages },
      };
      const list = byQuestion.get(record.questionId);
      if (list) list.push(record);
      else byQuestion.set(record.questionId, [record]);
    }

    const selected: MergedExportRecord[] = [];
    let duplicateQuestionsResolved = 0;
    const conflicts: string[] = [];

    for (const [questionId, list] of [...byQuestion.entries()].sort((a, b) => a[0] - b[0])) {
      list.sort((a, b) => a.runId - b.runId);
      if (list.length > 1) {
        if (dedup === "error") {
          conflicts.push(`q${questionId} (runs: ${list.map((r) => r.runId).join(",")})`);
          continue;
        }
        duplicateQuestionsResolved += list.length - 1;
        selected.push(dedup === "latest" ? list[list.length - 1] : list[0]);
      } else {
        selected.push(list[0]);
      }
    }

    if (conflicts.length > 0) {
      throw new Error(`发现同题多版本冲突（--dedup error）：${conflicts.join("; ")}`);
    }

    const rng = options.seed !== undefined ? createSeededRng(options.seed) : Math.random;
    const allMaterials = [...new Set(selected.map((r) => r.materialId))].sort((a, b) => a - b);
    const videoKeyOfMaterial = (matId: number): string => materialInfo.get(matId)?.videoKey ?? String(matId);
    const allVideoKeys = [...new Set(allMaterials.map(videoKeyOfMaterial))].sort();

    let train: MergedExportRecord[];
    let val: MergedExportRecord[];

    if (options.valRatio !== undefined) {
      if (allVideoKeys.length < 2) {
        throw new Error("按视频切分验证集至少需要 2 个不同视频（material）");
      }
      const shuffledVideoKeys = shuffleInPlace([...allVideoKeys], rng);
      const valVideoCount = Math.min(allVideoKeys.length - 1, Math.max(1, Math.round(allVideoKeys.length * options.valRatio)));
      const valVideoKeySet = new Set(shuffledVideoKeys.slice(0, valVideoCount));
      train = selected.filter((r) => !valVideoKeySet.has(videoKeyOfMaterial(r.materialId)));
      val = selected.filter((r) => valVideoKeySet.has(videoKeyOfMaterial(r.materialId)));
    } else {
      train = [...selected];
      val = [];
    }

    if (options.shuffle) {
      shuffleInPlace(train, rng);
      if (val.length > 0) shuffleInPlace(val, rng);
    }

    const countsByRunId: Record<number, number> = {};
    const turnCountDistribution: Record<number, number> = {};
    for (const rec of selected) {
      countsByRunId[rec.runId] = (countsByRunId[rec.runId] ?? 0) + 1;
      turnCountDistribution[rec.turnCount] = (turnCountDistribution[rec.turnCount] ?? 0) + 1;
    }

    return {
      train,
      val,
      includedRunIds: Object.keys(countsByRunId).map(Number).sort((a, b) => a - b),
      countsByRunId,
      turnCountDistribution,
      duplicateQuestionsResolved,
      materialCount: allMaterials.length,
      trainMaterialCount: new Set(train.map((r) => r.materialId)).size,
      valMaterialCount: new Set(val.map((r) => r.materialId)).size,
    };
  }

  getTestSetVersion(nameOrId: string | number): TestSetVersionRecord | undefined {
    if (!this.hasTable("test_set_versions")) return undefined;
    if (typeof nameOrId === "number") {
      return this.db.prepare(
        "SELECT id, name, split, result_ids_json, sample_count, video_count, manifest_json, sha256, created_at FROM test_set_versions WHERE id = ?",
      ).get(nameOrId) as unknown as TestSetVersionRecord | undefined;
    }
    return this.db.prepare(
      "SELECT id, name, split, result_ids_json, sample_count, video_count, manifest_json, sha256, created_at FROM test_set_versions WHERE name = ?",
    ).get(nonEmpty(nameOrId, "version name")) as unknown as TestSetVersionRecord | undefined;
  }

  listTestSetVersions(split?: "test" | "dpo"): TestSetVersionRecord[] {
    if (!this.hasTable("test_set_versions")) return [];
    if (split !== undefined) {
      return this.db.prepare(
        "SELECT id, name, split, result_ids_json, sample_count, video_count, manifest_json, sha256, created_at FROM test_set_versions WHERE split = ? ORDER BY id",
      ).all(split) as unknown as TestSetVersionRecord[];
    }
    return this.db.prepare(
      "SELECT id, name, split, result_ids_json, sample_count, video_count, manifest_json, sha256, created_at FROM test_set_versions ORDER BY id",
    ).all() as unknown as TestSetVersionRecord[];
  }

  freezeTestSetVersion(input: {
    name: string;
    split?: "test" | "dpo";
    runIds?: number[];
    dedup?: DedupPolicy;
    minTurns?: number;
    maxTurns?: number;
    systemPrompt?: string;
    createdAt?: string;
  }): TestSetVersionRecord {
    const name = nonEmpty(input.name, "version name");
    const split = input.split ?? "test";
    if (split !== "test" && split !== "dpo") {
      throw new Error("冻结评测集版本的 split 必须为 test 或 dpo（禁止将 train 冻结为测试集）");
    }

    const merged = this.exportMergedDataset({
      allFormal: input.runIds === undefined,
      runIds: input.runIds,
      split,
      dedup: input.dedup ?? "latest",
      minTurns: input.minTurns,
      maxTurns: input.maxTurns,
      systemPrompt: input.systemPrompt,
    });

    if (merged.train.length === 0) {
      throw new Error(`未找到属于 ${split} 分区的已通过样本，无法冻结版本 ${name}`);
    }

    const materialInfo = this.corpus.getMaterialVideoAndSplitMap();
    const videoKeys = [...new Set(merged.train.map((r) => materialInfo.get(r.materialId)?.videoKey ?? String(r.materialId)))].sort();
    for (const r of merged.train) {
      const matSplit = materialInfo.get(r.materialId)?.split;
      if (matSplit !== split) {
        throw new Error(`样本 result_id=${r.resultId} 的视频不属于 ${split} 分区（实际为 ${matSplit ?? "unassigned"}）`);
      }
    }

    const resultIds = merged.train.map((r) => r.resultId);
    const jsonl = formatSamplesJsonl(merged.train.map((r) => r.sample));
    const sha256 = sha256Hex(jsonl);
    const createdAt = input.createdAt ?? nowIso();

    const existing = this.getTestSetVersion(name);
    if (existing) {
      if (existing.sha256 === sha256 && existing.split === split) {
        return existing;
      }
      throw new Error(`测试集版本 ${name} 已冻结（sha256=${existing.sha256.slice(0, 12)}），禁止覆盖为不同内容`);
    }

    const manifest = {
      name,
      split,
      sampleCount: merged.train.length,
      videoCount: videoKeys.length,
      materialCount: merged.materialCount,
      videoKeys,
      resultIds,
      questionIds: merged.train.map((r) => r.questionId),
      includedRunIds: merged.includedRunIds,
      turnCountDistribution: merged.turnCountDistribution,
      sha256,
    };

    this.db.prepare(`
      INSERT INTO test_set_versions (name, split, result_ids_json, sample_count, video_count, manifest_json, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      split,
      JSON.stringify(resultIds),
      merged.train.length,
      videoKeys.length,
      JSON.stringify(manifest),
      sha256,
      createdAt,
    );

    const created = this.getTestSetVersion(name);
    if (!created) throw new Error(`无法读取冻结版本：${name}`);
    return created;
  }
}
