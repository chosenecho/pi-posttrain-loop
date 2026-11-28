import { assertDistinctDatabaseFiles } from "../shared/database-path.js";
import { nonEmpty } from "../shared/schema.js";
import type { DatasetSplit } from "../shared/types.js";
import { createSeededRng, extractVideoKey, sha256Hex, shuffleInPlace } from "../shared/utils.js";
import { loadVideoChunks, scanCorpusVideos, type VideoUnit } from "../synth/corpus.js";
import { DataMakerStore } from "../synth/store/index.js";
import { EvalStore, type SourceMaterialRecord } from "./store/index.js";

function loadMainMaterialIndex(rows: ReadonlyArray<{ id: number; video_id: string; sha256: string }>): Map<string, { id: number; sha256: string }> {
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
  maxChunkChars?: number;
}

export interface ImportTestSourcesReport {
  importedVideos: number;
  importedChunks: number;
  skippedExistingChunks: number;
  videoKeys: string[];
  totalSourceMaterials: number;
  candidateTestVideos: number;
  selectedSourceMaterialIds: number[];
}

/**
 * Imports immutable snapshots of `split = 'test'` video transcripts into `eval.sqlite`.
 * Always opens the main database read-only and refuses any non-test video.
 */
export async function importTestSources(options: ImportTestSourcesOptions): Promise<ImportTestSourcesReport> {
  const { evalStore, mainDbPath } = options;
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit 必须是正整数");
  }
  if (options.seed !== undefined && !Number.isSafeInteger(options.seed)) {
    throw new Error("--seed 必须是整数");
  }

  assertDistinctDatabaseFiles(mainDbPath, evalStore.path);
  const mainStore = new DataMakerStore(mainDbPath, { readOnly: true });
  try {
    const snapshot = mainStore.readCorpusSourceSnapshot({ includeContent: options.units === undefined && options.inputDir === undefined });
    const { splits } = snapshot;
    if (splits.length === 0) {
      throw new Error("主库中尚未注册 video_splits，请先在主库完成分区同步");
    }
    const splitByKey = new Map<string, DatasetSplit>();
    for (const row of splits) {
      splitByKey.set(row.video_key, row.split);
    }

    const requestedKeys =
      options.videoKeys && options.videoKeys.length > 0
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

    const mainMaterialIndex = loadMainMaterialIndex(snapshot.materials);

    // Mode 1: Corpus directory or explicit VideoUnit list
    if (options.units !== undefined || options.inputDir !== undefined) {
      const units = options.units ?? (await scanCorpusVideos(options.inputDir!));
      const requestedSet = requestedKeys ? new Set(requestedKeys) : undefined;
      const candidates = units.filter((unit) => {
        const videoKey = extractVideoKey(unit.videoId);
        if (splitByKey.get(videoKey) !== "test") return false;
        if (requestedSet && !requestedSet.has(videoKey)) return false;
        return true;
      });

      const ordered = [...candidates];
      if (options.shuffle) {
        const rng = options.seed !== undefined ? createSeededRng(options.seed) : Math.random;
        shuffleInPlace(ordered, rng);
      }
      const selected = options.limit !== undefined ? ordered.slice(0, options.limit) : ordered;

      let importedChunks = 0;
      let skippedExistingChunks = 0;
      const importedVideoKeys: string[] = [];
      const selectedSourceMaterialIds: number[] = [];

      for (const unit of selected) {
        const videoKey = extractVideoKey(unit.videoId);
        const splitSnapshot = splitByKey.get(videoKey);
        if (splitSnapshot !== "test") {
          throw new Error(`导入守卫拦截：视频 ${videoKey} 实际为 ${splitSnapshot ?? "未注册"}`);
        }
        const chunks = await loadVideoChunks(unit, { maxChunkChars: options.maxChunkChars });
        let createdForVideo = false;
        evalStore.transaction(() => {
          for (const chunk of chunks) {
            const match = mainMaterialIndex.get(`${chunk.videoId}\0${chunk.sha256}`);
            const { created, record } = evalStore.insertSourceMaterial({
              videoId: chunk.videoId,
              videoKey,
              mainMaterialId: match?.id ?? null,
              partCount: chunk.partCount,
              content: chunk.content,
              sourcePath: chunk.sourcePath,
              splitSnapshot,
            });
            selectedSourceMaterialIds.push(record.id);
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
        selectedSourceMaterialIds,
      };
    }

    // Mode 2: Fallback to main DB's `materials` table (only `split = 'test'`)
    const rows = snapshot.materialContents;
    const requestedSet = requestedKeys ? new Set(requestedKeys) : undefined;
    const byVideoKey = new Map<string, typeof rows>();
    for (const row of rows) {
      const videoKey = extractVideoKey(row.video_id);
      if (splitByKey.get(videoKey) !== "test") continue;
      if (requestedSet && !requestedSet.has(videoKey)) continue;
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
    const selectedSourceMaterialIds: number[] = [];

    for (const videoKey of selectedKeys) {
      let createdForVideo = false;
      evalStore.transaction(() => {
        for (const row of byVideoKey.get(videoKey)!) {
          const { created, record } = evalStore.insertSourceMaterial({
            videoId: row.video_id,
            videoKey,
            mainMaterialId: Number(row.id),
            partCount: 1,
            content: row.content,
            sourcePath: row.source_path,
            splitSnapshot: "test",
          });
          selectedSourceMaterialIds.push(record.id);
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
      selectedSourceMaterialIds,
    };
  } finally {
    mainStore.close();
  }
}

/**
 * Cross-DB guard executed before every build and freeze:
 * re-checks every source material's `video_key` in the main DB (read-only) to confirm
 * it is still registered in `split = 'test'`, and verifies content sha256 integrity.
 */
export function verifySourceSplits(
  mainDbPath: string,
  sources: SourceMaterialRecord[],
  splitSnapshot?: readonly { video_key: string; split: DatasetSplit }[],
): void {
  if (sources.length === 0) return;

  for (const source of sources) {
    const actualSha = sha256Hex(source.content);
    if (actualSha !== source.contentSha256) {
      throw new Error(
        `材料快照校验失败：${source.videoId} 内容 sha256 不一致（预期 ${source.contentSha256.slice(0, 12)}，实际 ${actualSha.slice(0, 12)}）`,
      );
    }
  }

  const splits = splitSnapshot ?? (() => {
    const mainStore = new DataMakerStore(mainDbPath, { readOnly: true });
    try { return mainStore.listVideoSplits(); } finally { mainStore.close(); }
  })();
  const splitByKey = new Map(splits.map((row) => [row.video_key, row.split]));
  const invalid: string[] = [];
  for (const source of sources) {
    const assigned = splitByKey.get(source.videoKey);
    if (assigned !== "test") invalid.push(`${source.videoKey}(实际=${assigned ?? "未注册"})`);
  }
  if (invalid.length > 0) {
    throw new Error(`跨库分区复核失败：以下评测材料不属于主库 test 分区：${invalid.slice(0, 10).join(", ")}`);
  }
}
