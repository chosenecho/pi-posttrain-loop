import { queryProcessedVideoIndex, type VideoUnit } from "./corpus.js";
import { DataMakerStore, extractVideoKey, sha256Hex, type VideoSplitRecord } from "./db.js";
import { nonEmpty, validateSplit } from "./schema.js";
import type { DatasetSplit, SplitAssignMethod } from "./types.js";

export const DEFAULT_SPLIT_SALT = "weimingzi-split-v1";
export const DEFAULT_TEST_RATIO = 0.10;
export const DEFAULT_DPO_RATIO = 0.10;

export interface SplitRatioOptions {
  salt?: string;
  testRatio?: number;
  dpoRatio?: number;
}

export interface SplitBucketCounts {
  totalVideos: number;
  processedVideos: number;
  unprocessedVideos: number;
  questions: number;
  passedResults: number;
}

export type SplitBreakdown = Record<DatasetSplit, SplitBucketCounts>;

/**
 * Deterministic hash bucket in [0, 1) for a canonical videoKey.
 * Multi-P chunks (`BVxxxx/P001-P004`, `BVxxxx/P005`) normalize to the same `videoKey` (`BVxxxx`)
 * and therefore always receive the exact same bucket.
 */
export function computeHashBucket(videoIdOrKey: string, salt = DEFAULT_SPLIT_SALT): number {
  const videoKey = extractVideoKey(nonEmpty(videoIdOrKey, "video_key"));
  const cleanSalt = nonEmpty(salt, "salt");
  const hex = sha256Hex(`${cleanSalt}:${videoKey}`).slice(0, 8);
  return Number.parseInt(hex, 16) / 0x1_0000_0000;
}

/**
 * Deterministically assigns a videoKey to `'test' | 'dpo' | 'train'` using SHA-256 hash buckets:
 * - `[0, testRatio)` -> `'test'`
 * - `[testRatio, testRatio + dpoRatio)` -> `'dpo'`
 * - `[testRatio + dpoRatio, 1)` -> `'train'`
 */
export function computeVideoSplit(
  videoIdOrKey: string,
  options: SplitRatioOptions = {},
): DatasetSplit {
  const testRatio = options.testRatio ?? DEFAULT_TEST_RATIO;
  const dpoRatio = options.dpoRatio ?? DEFAULT_DPO_RATIO;
  if (!Number.isFinite(testRatio) || testRatio < 0 || testRatio >= 1) {
    throw new Error("testRatio 必须是 [0, 1) 之间的数值");
  }
  if (!Number.isFinite(dpoRatio) || dpoRatio < 0 || dpoRatio >= 1) {
    throw new Error("dpoRatio 必须是 [0, 1) 之间的数值");
  }
  if (testRatio + dpoRatio >= 1) {
    throw new Error("testRatio + dpoRatio 必须小于 1");
  }
  const bucket = computeHashBucket(videoIdOrKey, options.salt ?? DEFAULT_SPLIT_SALT);
  if (bucket < testRatio) return "test";
  if (bucket < testRatio + dpoRatio) return "dpo";
  return "train";
}

/**
 * Locks all already-processed videos in `materials` (those that already have questions or completed question calls)
 * as `split = 'train', method = 'backfill'` if they do not yet have an entry in `video_splits`.
 * Guarantees historical SFT training videos can never be reassigned into `test` or `dpo`.
 */
export function backfillProcessedTrainSplits(
  store: DataMakerStore,
  salt = DEFAULT_SPLIT_SALT,
): number {
  const { processedVideoKeys } = queryProcessedVideoIndex(store);
  let backfilled = 0;
  store.transaction(() => {
    for (const videoKey of [...processedVideoKeys].sort()) {
      const existing = store.getVideoSplit(videoKey);
      if (!existing) {
        store.assignVideoSplit({
          videoKey,
          split: "train",
          method: "backfill",
          salt,
        });
        backfilled++;
      }
    }
  });
  return backfilled;
}

/**
 * Ensures a canonical videoKey has a persistent split entry in `video_splits`.
 * Once assigned, a video's split is immutable.
 */
export function ensureVideoSplit(
  store: DataMakerStore,
  videoIdOrKey: string,
  options: SplitRatioOptions & {
    preferredSplit?: DatasetSplit;
    method?: SplitAssignMethod;
  } = {},
): VideoSplitRecord {
  const videoKey = extractVideoKey(nonEmpty(videoIdOrKey, "video_key"));
  const existing = store.getVideoSplit(videoKey);
  if (existing) {
    if (
      options.method === "manual"
      && options.preferredSplit !== undefined
      && existing.split !== options.preferredSplit
    ) {
      throw new Error(
        `视频 ${videoKey} 已锁定在 ${existing.split} 分区（method=${existing.method}），不能改为 ${options.preferredSplit}`,
      );
    }
    return existing;
  }

  const split = options.preferredSplit !== undefined
    ? validateSplit(options.preferredSplit)
    : computeVideoSplit(videoKey, options);
  const method: SplitAssignMethod = options.method ?? (options.preferredSplit !== undefined ? "manual" : "hash");
  return store.assignVideoSplit({
    videoKey,
    split,
    method,
    salt: options.salt ?? DEFAULT_SPLIT_SALT,
  });
}

/**
 * Synchronizes a scanned corpus with the persistent `video_splits` registry:
 * 1. First backfills any historically processed videos in SQLite as `'train'` (`method = 'backfill'`).
 * 2. Hash-assigns all remaining corpus videos into `'train' | 'test' | 'dpo'`.
 * Returns a map from canonical `videoKey` to `VideoSplitRecord`.
 */
export function syncCorpusSplits(
  store: DataMakerStore,
  units: VideoUnit[],
  options: SplitRatioOptions = {},
): Map<string, VideoSplitRecord> {
  return store.transaction(() => {
    backfillProcessedTrainSplits(store, options.salt ?? DEFAULT_SPLIT_SALT);
    for (const unit of units) {
      ensureVideoSplit(store, unit.videoId, options);
    }
    const map = new Map<string, VideoSplitRecord>();
    for (const rec of store.listVideoSplits()) {
      map.set(rec.video_key, rec);
    }
    return map;
  });
}

/**
 * Summarizes per-split video, question, and passed result counts across the corpus and database.
 */
export function summarizeSplitCounts(
  store: DataMakerStore,
  units: VideoUnit[] = [],
  options: SplitRatioOptions = {},
): SplitBreakdown {
  const { processedVideoKeys } = queryProcessedVideoIndex(store);
  const persistedMap = new Map<string, DatasetSplit>();
  for (const row of store.listVideoSplits()) {
    persistedMap.set(row.video_key, row.split);
  }

  const allVideoKeys = new Set<string>(persistedMap.keys());
  for (const unit of units) {
    allVideoKeys.add(extractVideoKey(unit.videoId));
  }
  for (const key of processedVideoKeys) {
    allVideoKeys.add(key);
  }

  const resolveSplit = (videoKey: string): DatasetSplit => {
    const persisted = persistedMap.get(videoKey);
    if (persisted) return persisted;
    if (processedVideoKeys.has(videoKey)) return "train";
    return computeVideoSplit(videoKey, options);
  };

  const breakdown: SplitBreakdown = {
    train: { totalVideos: 0, processedVideos: 0, unprocessedVideos: 0, questions: 0, passedResults: 0 },
    test: { totalVideos: 0, processedVideos: 0, unprocessedVideos: 0, questions: 0, passedResults: 0 },
    dpo: { totalVideos: 0, processedVideos: 0, unprocessedVideos: 0, questions: 0, passedResults: 0 },
  };

  const corpusVideoKeys = units.length > 0
    ? new Set(units.map((u) => extractVideoKey(u.videoId)))
    : allVideoKeys;

  for (const videoKey of corpusVideoKeys) {
    const split = resolveSplit(videoKey);
    const slot = breakdown[split];
    slot.totalVideos++;
    if (processedVideoKeys.has(videoKey)) {
      slot.processedVideos++;
    } else {
      slot.unprocessedVideos++;
    }
  }

  const qRows = store.db.prepare(`
    SELECT m.video_id, COUNT(q.id) AS q_count
    FROM questions q
    JOIN materials m ON m.id = q.material_id
    GROUP BY m.video_id
  `).all() as Array<{ video_id: string; q_count: number }>;

  for (const row of qRows) {
    const split = resolveSplit(extractVideoKey(row.video_id));
    breakdown[split].questions += Number(row.q_count);
  }

  const resRows = store.db.prepare(`
    SELECT m.video_id, COUNT(DISTINCT i.question_id) AS pass_count
    FROM results r
    JOIN run_items i ON i.id = r.run_item_id
    JOIN questions q ON q.id = i.question_id
    JOIN materials m ON m.id = q.material_id
    GROUP BY m.video_id
  `).all() as Array<{ video_id: string; pass_count: number }>;

  for (const row of resRows) {
    const split = resolveSplit(extractVideoKey(row.video_id));
    breakdown[split].passedResults += Number(row.pass_count);
  }

  return breakdown;
}
