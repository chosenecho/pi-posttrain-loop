import { nonEmpty } from "../shared/schema.js";
import type { DatasetSplit } from "../shared/types.js";
import { extractVideoKey, sha256Hex } from "../shared/utils.js";

export const DEFAULT_SPLIT_SALT = "weimingzi-split-v1";
export const DEFAULT_TEST_RATIO = 0.10;
export const DEFAULT_DPO_RATIO = 0.10;

export interface SplitRatioOptions {
  salt?: string;
  testRatio?: number;
  dpoRatio?: number;
}

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
