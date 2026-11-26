import { nonEmpty, validateSplit } from "../shared/schema.js";
import type { DatasetSplit, SplitAssignMethod } from "../shared/types.js";
import { extractVideoKey } from "../shared/utils.js";
import { queryProcessedVideoIndex, type VideoUnit } from "./corpus.js";
import {
  computeHashBucket,
  computeVideoSplit,
  DEFAULT_DPO_RATIO,
  DEFAULT_SPLIT_SALT,
  DEFAULT_TEST_RATIO,
  type SplitRatioOptions,
} from "./split-hash.js";
import type { DataMakerStore, VideoSplitRecord } from "./store/index.js";

export {
  computeHashBucket,
  computeVideoSplit,
  DEFAULT_DPO_RATIO,
  DEFAULT_SPLIT_SALT,
  DEFAULT_TEST_RATIO,
  type SplitRatioOptions,
};

export interface SplitBucketCounts {
  totalVideos: number;
  processedVideos: number;
  unprocessedVideos: number;
  questions: number;
  passedResults: number;
}

export type SplitBreakdown = Record<DatasetSplit, SplitBucketCounts>;

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

  for (const row of store.queryQuestionCountsByVideo()) {
    const split = resolveSplit(extractVideoKey(row.video_id));
    breakdown[split].questions += Number(row.q_count);
  }

  for (const row of store.queryPassedResultCountsByVideo()) {
    const split = resolveSplit(extractVideoKey(row.video_id));
    breakdown[split].passedResults += Number(row.pass_count);
  }

  return breakdown;
}
