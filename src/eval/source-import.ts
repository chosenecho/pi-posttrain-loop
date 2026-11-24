import { DataMakerStore, extractVideoKey, formatSamplesJsonl, sha256Hex as mainSha256Hex } from "../db.js";
import { loadVideoChunks, queryProcessedVideoIndex, scanCorpusVideos, type VideoUnit } from "../corpus.js";
import { nonEmpty } from "../schema.js";
import type { DatasetSplit, EvalRubric } from "../types.js";
import { EvalStore, nowIso, sha256Hex, type SourceMaterialRecord } from "./eval-db.js";

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function collectMainUsedVideoKeys(mainStore: DataMakerStore): Set<string> {
  const used = new Set<string>(queryProcessedVideoIndex(mainStore).processedVideoKeys);
  for (const version of mainStore.listTestSetVersions()) {
    try {
      const manifest = JSON.parse(version.manifest_json) as { videoKeys?: unknown };
      if (Array.isArray(manifest.videoKeys)) {
        for (const key of manifest.videoKeys) {
          if (typeof key === "string" && key.trim()) {
            used.add(extractVideoKey(key));
          }
        }
      }
    } catch {
      // Ignore malformed manifest JSON
    }
  }
  return used;
}

function loadMainMaterialIndex(mainStore: DataMakerStore): Map<string, { id: number; sha256: string }> {
  const rows = mainStore.db.prepare("SELECT id, video_id, sha256 FROM materials").all() as Array<{
    id: number;
    video_id: string;
    sha256: string;
  }>;
  const map = new Map<string, { id: number; sha256: string }>();
  for (const row of rows) {
    map.set(`${row.video_id}\0${row.sha256}`, { id: Number(row.id), sha256: row.sha256 });
  }
  return map;
}

export interface ImportTestSourcesOptions {
  evalStore: EvalStore;
  mainDbPath: string;
  inputDir?: string;
  units?: VideoUnit[];
  videoKeys?: string[];
  limit?: number;
  shuffle?: boolean;
  seed?: number;
  excludeUsed?: boolean;
  maxChunkChars?: number;
}

export interface ImportTestSourcesReport {
  importedVideos: number;
  importedChunks: number;
  skippedExistingChunks: number;
  videoKeys: string[];
  totalSourceMaterials: number;
  candidateTestVideos: number;
}

/**
 * Imports immutable snapshots of `split = 'test'` video transcripts into `eval.sqlite`.
 * Always opens the main database with `readOnly: true` and refuses non-test videos.
 */
export async function importTestSources(options: ImportTestSourcesOptions): Promise<ImportTestSourcesReport> {
  const { evalStore, mainDbPath } = options;
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit 必须是正整数");
  }
  if (options.seed !== undefined && !Number.isSafeInteger(options.seed)) {
    throw new Error("--seed 必须是整数");
  }

  const mainStore = new DataMakerStore(mainDbPath, { readOnly: true });
  try {
    const splits = mainStore.listVideoSplits();
    if (splits.length === 0) {
      throw new Error("主库中尚未注册 video_splits，请先在主库完成分区同步");
    }
    const splitByKey = new Map<string, DatasetSplit>();
    for (const row of splits) {
      splitByKey.set(row.video_key, row.split);
    }

    const requestedKeys = options.videoKeys && options.videoKeys.length > 0
      ? [...new Set(options.videoKeys.map((k) => extractVideoKey(nonEmpty(k, "videoKey"))))]
      : undefined;

    if (requestedKeys) {
      for (const key of requestedKeys) {
        const assigned = splitByKey.get(key);
        if (assigned !== "test") {
          throw new Error(`导入守卫拦截：视频 ${key} 不属于 test 分区（实际为 ${assigned ?? "未注册"}）`);
        }
      }
    }

    const usedKeys = options.excludeUsed
      ? new Set<string>([...collectMainUsedVideoKeys(mainStore), ...evalStore.listEvalVideoKeys()])
      : new Set<string>();
    const mainMaterialIndex = loadMainMaterialIndex(mainStore);

    // Source mode 1: Corpus directory or explicit VideoUnit list
    if (options.units !== undefined || options.inputDir !== undefined) {
      const units = options.units ?? await scanCorpusVideos(options.inputDir!);
      const requestedSet = requestedKeys ? new Set(requestedKeys) : undefined;

      const candidates = units.filter((unit) => {
        const videoKey = extractVideoKey(unit.videoId);
        if (splitByKey.get(videoKey) !== "test") return false;
        if (requestedSet && !requestedSet.has(videoKey)) return false;
        if (!requestedSet && options.excludeUsed && usedKeys.has(videoKey)) return false;
        return true;
      });

      if (requestedSet) {
        const foundKeys = new Set(candidates.map((u) => extractVideoKey(u.videoId)));
        const missing = [...requestedSet].filter((k) => !foundKeys.has(k));
        if (missing.length > 0) {
          throw new Error(`语料目录中未找到请求的 test 视频：${missing.join(", ")}`);
        }
      }

      const pool = [...candidates];
      if (options.shuffle) {
        const rng = options.seed !== undefined ? createSeededRng(options.seed) : Math.random;
        shuffleInPlace(pool, rng);
      }
      const selected = options.limit !== undefined ? pool.slice(0, options.limit) : pool;

      let importedChunks = 0;
      let skippedExistingChunks = 0;
      const importedVideoKeys: string[] = [];

      for (const unit of selected) {
        const videoKey = extractVideoKey(unit.videoId);
        // Re-verify split right before inserting
        const splitSnapshot = splitByKey.get(videoKey);
        if (splitSnapshot !== "test") {
          throw new Error(`导入守卫拦截：视频 ${videoKey} 实际为 ${splitSnapshot ?? "未注册"}`);
        }
        const chunks = await loadVideoChunks(unit, { maxChunkChars: options.maxChunkChars });
        let createdForVideo = false;
        evalStore.transaction(() => {
          for (const chunk of chunks) {
            const match = mainMaterialIndex.get(`${chunk.videoId}\0${chunk.sha256}`);
            const { created } = evalStore.insertSourceMaterial({
              videoId: chunk.videoId,
              videoKey,
              mainMaterialId: match?.id ?? null,
              partCount: chunk.partCount,
              content: chunk.content,
              sourcePath: chunk.sourcePath,
              splitSnapshot,
            });
            if (created) {
              importedChunks++;
              createdForVideo = true;
            } else {
              skippedExistingChunks++;
            }
          }
        });
        if (createdForVideo) importedVideoKeys.push(videoKey);
      }

      return {
        importedVideos: importedVideoKeys.length,
        importedChunks,
        skippedExistingChunks,
        videoKeys: importedVideoKeys,
        totalSourceMaterials: evalStore.listSourceMaterials().length,
        candidateTestVideos: candidates.length,
      };
    }

    // Source mode 2: Fallback to main DB's `materials` table (only `split = 'test'`)
    const rows = mainStore.db.prepare(
      "SELECT id, video_id, content, sha256, source_path FROM materials ORDER BY id",
    ).all() as Array<{ id: number; video_id: string; content: string; sha256: string; source_path: string | null }>;

    const requestedSet = requestedKeys ? new Set(requestedKeys) : undefined;
    const byVideoKey = new Map<string, typeof rows>();
    for (const row of rows) {
      const videoKey = extractVideoKey(row.video_id);
      if (splitByKey.get(videoKey) !== "test") continue;
      if (requestedSet && !requestedSet.has(videoKey)) continue;
      if (!requestedSet && options.excludeUsed && usedKeys.has(videoKey)) continue;
      const list = byVideoKey.get(videoKey);
      if (list) list.push(row);
      else byVideoKey.set(videoKey, [row]);
    }

    const candidateKeys = [...byVideoKey.keys()];
    if (options.shuffle) {
      const rng = options.seed !== undefined ? createSeededRng(options.seed) : Math.random;
      shuffleInPlace(candidateKeys, rng);
    }
    const selectedKeys = options.limit !== undefined ? candidateKeys.slice(0, options.limit) : candidateKeys;

    let importedChunks = 0;
    let skippedExistingChunks = 0;
    const importedVideoKeys: string[] = [];

    for (const videoKey of selectedKeys) {
      let createdForVideo = false;
      evalStore.transaction(() => {
        for (const row of byVideoKey.get(videoKey)!) {
          const { created } = evalStore.insertSourceMaterial({
            videoId: row.video_id,
            videoKey,
            mainMaterialId: Number(row.id),
            partCount: 1,
            content: row.content,
            sourcePath: row.source_path,
            splitSnapshot: "test",
          });
          if (created) {
            importedChunks++;
            createdForVideo = true;
          } else {
            skippedExistingChunks++;
          }
        }
      });
      if (createdForVideo) importedVideoKeys.push(videoKey);
    }

    return {
      importedVideos: importedVideoKeys.length,
      importedChunks,
      skippedExistingChunks,
      videoKeys: importedVideoKeys,
      totalSourceMaterials: evalStore.listSourceMaterials().length,
      candidateTestVideos: candidateKeys.length,
    };
  } finally {
    mainStore.close();
  }
}

/**
 * Cross-DB guard executed before every `eval build`:
 * re-checks every source material's `video_key` in the main DB (read-only) to confirm
 * it is still registered in `split = 'test'`, and verifies content sha256 integrity.
 */
export function verifySourceSplits(mainDbPath: string, sources: SourceMaterialRecord[]): void {
  if (sources.length === 0) return;

  for (const source of sources) {
    const actualSha = sha256Hex(source.content);
    if (actualSha !== source.contentSha256) {
      throw new Error(
        `材料快照校验失败：${source.videoId} 内容 sha256 不一致（预期 ${source.contentSha256.slice(0, 12)}，实际 ${actualSha.slice(0, 12)}）`,
      );
    }
  }

  const mainStore = new DataMakerStore(mainDbPath, { readOnly: true });
  try {
    for (const source of sources) {
      const splitRec = mainStore.getVideoSplit(source.videoKey);
      if (!splitRec || splitRec.split !== "test") {
        throw new Error(
          `跨库分区复核失败：${source.videoKey} 在主库中不是 test 分区（实际为 ${splitRec?.split ?? "未注册"}），中止构建`,
        );
      }
      if (source.mainMaterialId !== null) {
        const row = mainStore.db.prepare("SELECT sha256 FROM materials WHERE id = ?").get(source.mainMaterialId) as
          | { sha256: string }
          | undefined;
        if (row && row.sha256 !== source.contentSha256) {
          throw new Error(
            `跨库快照一致性校验失败：${source.videoId}（main_material_id=${source.mainMaterialId}）sha256 与主库不一致`,
          );
        }
      }
    }
  } finally {
    mainStore.close();
  }
}

export interface MirrorMainVersionOptions {
  evalStore: EvalStore;
  mainDbPath: string;
  fromVersion: string;
  asSuiteName: string;
}

export interface MirrorMainVersionReport {
  created: boolean;
  fromVersion: string;
  suiteName: string;
  kind: "in_distribution";
  itemCount: number;
  videoCount: number;
  rubricTurns: number;
  missingRubricTurns: number;
  sha256: string;
}

/**
 * Mirrors an immutable frozen `test` version (e.g. `test-v1`) from the main DB (read-only)
 * into `eval.sqlite` as an `in_distribution` suite (e.g. `indist-v1`), verifying exact sha256 parity.
 */
export function mirrorMainVersion(options: MirrorMainVersionOptions): MirrorMainVersionReport {
  const fromVersion = nonEmpty(options.fromVersion, "fromVersion");
  const asSuiteName = nonEmpty(options.asSuiteName, "asSuiteName");

  const mainStore = new DataMakerStore(options.mainDbPath, { readOnly: true });
  try {
    const version = mainStore.getTestSetVersion(fromVersion);
    if (!version) {
      throw new Error(`主库中未找到测试集版本：${fromVersion}`);
    }
    if (version.split !== "test") {
      throw new Error(`镜像守卫拦截：版本 ${fromVersion} 属于 ${version.split} 分区，仅允许镜像 test 分区版本`);
    }

    const merged = mainStore.exportMergedDataset({
      versionName: fromVersion,
      split: "test",
    });

    const jsonl = formatSamplesJsonl(merged.train.map((r) => r.sample));
    const computedSha256 = mainSha256Hex(jsonl);
    if (computedSha256 !== version.sha256) {
      throw new Error(
        `版本 ${fromVersion} sha256 校验失败：主库记录 ${version.sha256}，重新导出计算为 ${computedSha256}`,
      );
    }

    const materialInfo = mainStore.getMaterialVideoAndSplitMap();
    const videoKeys = new Set<string>();
    let rubricTurns = 0;
    let missingRubricTurns = 0;

    const items = merged.train.map((record) => {
      const info = materialInfo.get(record.materialId);
      if (!info || info.split !== "test") {
        throw new Error(
          `镜像守卫拦截：样本 result_id=${record.resultId} 的材料不属于 test 分区（实际为 ${info?.split ?? "未知"}）`,
        );
      }
      videoKeys.add(info.videoKey);

      const rubrics: Array<{ turnNo: number; rubric: EvalRubric | null }> = [];
      for (let turnNo = 1; turnNo <= record.turnCount; turnNo++) {
        const rec = mainStore.getEvalRubric(record.resultId, turnNo);
        if (rec) {
          rubricTurns++;
          rubrics.push({ turnNo, rubric: rec.rubric });
        } else {
          missingRubricTurns++;
          rubrics.push({ turnNo, rubric: null });
        }
      }

      return {
        itemKey: `${fromVersion}:result:${record.resultId}`,
        videoKey: info.videoKey,
        probeType: null,
        expectedBehavior: null,
        messages: record.sample.messages,
        rubrics,
      };
    });

    const { created, suite } = options.evalStore.freezeSuite({
      name: asSuiteName,
      kind: "in_distribution",
      sha256: version.sha256,
      manifest: {
        sourceVersion: fromVersion,
        sourceSplit: version.split,
        sourceMainDb: options.mainDbPath,
        sampleCount: items.length,
        videoCount: videoKeys.size,
        videoKeys: [...videoKeys].sort(),
        rubricTurns,
        missingRubricTurns,
        sourceSha256: version.sha256,
        mirroredAt: nowIso(),
      },
      items,
    });

    if (created) {
      const runId = options.evalStore.createRun({
        kind: "mirror",
        config: {
          fromVersion,
          asSuiteName,
          mainDbPath: options.mainDbPath,
          itemCount: items.length,
          sha256: version.sha256,
        },
        prompts: {},
        skills: [],
      });
      options.evalStore.finishRun(runId, "completed");
    }

    return {
      created,
      fromVersion,
      suiteName: suite.name,
      kind: "in_distribution",
      itemCount: suite.itemCount,
      videoCount: videoKeys.size,
      rubricTurns,
      missingRubricTurns,
      sha256: suite.sha256,
    };
  } finally {
    mainStore.close();
  }
}
