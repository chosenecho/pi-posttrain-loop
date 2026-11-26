import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { validateSplit } from "../shared/schema.js";
import type { DatasetSplit } from "../shared/types.js";
import { extractVideoKey, normalizeText, sha256Hex } from "../shared/utils.js";
import { computeVideoSplit } from "./split-hash.js";
import type { DataMakerStore } from "./store/index.js";

export { extractVideoKey };

export interface VideoUnit {
  /** Video-level canonical identifier (e.g. BV1154y1b7Bb, youtube/0iLy_lI8H4Y, audio/i-xxxx). */
  videoId: string;
  /** Source category discovered in the corpus. */
  sourceGroup: "by_bv" | "youtube" | "audio" | "single";
  /** Ordered list of .md part files belonging to this video. */
  partPaths: string[];
  /** Folder path (for directory-backed videos) or single file path. */
  sourcePath: string;
}

export interface LoadedVideoUnit extends VideoUnit {
  content: string;
  sha256: string;
  partCount: number;
}

export interface CorpusStatus {
  totalVideos: number;
  totalPartFiles: number;
  multiPartVideos: number;
  processedVideos: number;
  unprocessedVideos: number;
  unprocessed: VideoUnit[];
}

const NATURAL_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export const DEFAULT_MAX_CHUNK_CHARS = 32_000;

export function computeQuestionQuota(
  charCount: number,
  partCount = 1,
  maxCap?: number,
): number {
  let base: number;
  if (charCount < 1_500) {
    base = 2;
  } else if (charCount < 5_000) {
    base = 3;
  } else if (charCount < 15_000) {
    base = 4;
  } else {
    base = 5;
  }
  const normalizedParts = Math.max(1, partCount);
  const effectiveParts = normalizedParts > 1
    ? Math.min(normalizedParts, Math.max(1, Math.floor(charCount / 2_000)))
    : 1;
  const partBonus = effectiveParts >= 3 ? 1 : 0;
  const computed = Math.min(6, base + partBonus);
  if (maxCap !== undefined) {
    return Math.max(1, Math.min(maxCap, computed));
  }
  return computed;
}

export function mergeVideoParts(parts: string[]): string {
  const cleaned = parts.map((raw) => normalizeText(raw).trim()).filter((text) => text.length > 0);
  if (cleaned.length === 0) throw new Error("视频文稿为空");
  if (cleaned.length === 1) return cleaned[0];

  const firstLines = cleaned[0].split("\n");
  const sharedHeading = firstLines[0]?.startsWith("# ") ? firstLines[0].trim() : null;

  const merged: string[] = [cleaned[0]];
  for (let i = 1; i < cleaned.length; i++) {
    let text = cleaned[i];
    if (sharedHeading) {
      const lines = text.split("\n");
      if (lines[0]?.trim() === sharedHeading) {
        let start = 1;
        while (start < lines.length && lines[start].trim() === "") start++;
        text = lines.slice(start).join("\n").trim();
      }
    }
    if (text.length > 0) merged.push(text);
  }
  return merged.join("\n\n");
}

async function scanVideoFolders(
  groupDir: string,
  sourceGroup: "by_bv" | "youtube",
): Promise<VideoUnit[]> {
  const entries = await readdir(groupDir, { withFileTypes: true });
  const units: VideoUnit[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderPath = join(groupDir, entry.name);
    const files = (await readdir(folderPath, { withFileTypes: true }))
      .filter((f) => f.isFile() && extname(f.name).toLowerCase() === ".md")
      .map((f) => f.name)
      .sort((a, b) => NATURAL_COLLATOR.compare(a, b));
    if (files.length === 0) continue;
    const videoId = sourceGroup === "by_bv" ? entry.name : `youtube/${entry.name}`;
    units.push({
      videoId,
      sourceGroup,
      partPaths: files.map((name) => join(folderPath, name)),
      sourcePath: folderPath,
    });
  }
  return units;
}

async function scanAudioFiles(groupDir: string): Promise<VideoUnit[]> {
  const entries = await readdir(groupDir, { withFileTypes: true });
  const units: VideoUnit[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") continue;
    const filePath = join(groupDir, entry.name);
    const stem = basename(entry.name, extname(entry.name));
    units.push({
      videoId: `audio/${stem}`,
      sourceGroup: "audio",
      partPaths: [filePath],
      sourcePath: filePath,
    });
  }
  return units;
}

export async function scanCorpusVideos(rootDir: string): Promise<VideoUnit[]> {
  const absRoot = resolve(rootDir);
  const rootStat = await stat(absRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`语料路径不是目录：${absRoot}`);
  }

  const entries = await readdir(absRoot, { withFileTypes: true });
  const subDirNames = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  const units: VideoUnit[] = [];

  if (subDirNames.has("by_bv") || subDirNames.has("youtube") || subDirNames.has("audio")) {
    if (subDirNames.has("by_bv")) {
      units.push(...await scanVideoFolders(join(absRoot, "by_bv"), "by_bv"));
    }
    if (subDirNames.has("youtube")) {
      units.push(...await scanVideoFolders(join(absRoot, "youtube"), "youtube"));
    }
    if (subDirNames.has("audio")) {
      units.push(...await scanAudioFiles(join(absRoot, "audio")));
    }
  } else {
    const dirName = basename(absRoot).toLowerCase();
    if (dirName === "audio") {
      units.push(...await scanAudioFiles(absRoot));
    } else if (dirName === "youtube") {
      units.push(...await scanVideoFolders(absRoot, "youtube"));
    } else {
      const folderUnits = await scanVideoFolders(absRoot, "by_bv");
      units.push(...folderUnits);
      for (const entry of entries) {
        if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") continue;
        const filePath = join(absRoot, entry.name);
        const stem = basename(entry.name, extname(entry.name));
        units.push({
          videoId: `${basename(absRoot)}/${stem}`,
          sourceGroup: "single",
          partPaths: [filePath],
          sourcePath: filePath,
        });
      }
    }
  }

  units.sort((a, b) => NATURAL_COLLATOR.compare(a.videoId, b.videoId));
  return units;
}

export async function loadVideoUnit(unit: VideoUnit): Promise<LoadedVideoUnit> {
  const partTexts = await Promise.all(unit.partPaths.map((p) => readFile(p, "utf8")));
  const content = mergeVideoParts(partTexts);
  return {
    ...unit,
    content,
    sha256: sha256Hex(content),
    partCount: unit.partPaths.length,
  };
}

export async function loadVideoChunks(
  unit: VideoUnit,
  options: { maxChunkChars?: number } = {},
): Promise<LoadedVideoUnit[]> {
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const rawParts = await Promise.all(unit.partPaths.map((p) => readFile(p, "utf8")));
  const nonEmptyEntries: Array<{ path: string; stem: string; text: string }> = [];
  for (let i = 0; i < unit.partPaths.length; i++) {
    const cleaned = normalizeText(rawParts[i]).trim();
    if (cleaned.length > 0) {
      nonEmptyEntries.push({
        path: unit.partPaths[i],
        stem: basename(unit.partPaths[i], extname(unit.partPaths[i])),
        text: cleaned,
      });
    }
  }
  if (nonEmptyEntries.length === 0) {
    throw new Error("视频文稿为空");
  }

  const fullMerged = mergeVideoParts(nonEmptyEntries.map((e) => e.text));
  if (nonEmptyEntries.length === 1 || fullMerged.length <= maxChunkChars) {
    return [{
      ...unit,
      content: fullMerged,
      sha256: sha256Hex(fullMerged),
      partCount: unit.partPaths.length,
    }];
  }

  const groups: Array<Array<{ path: string; stem: string; text: string }>> = [];
  let currentGroup: Array<{ path: string; stem: string; text: string }> = [];

  for (const entry of nonEmptyEntries) {
    if (currentGroup.length === 0) {
      currentGroup.push(entry);
      continue;
    }
    const candidateMerged = mergeVideoParts([...currentGroup.map((e) => e.text), entry.text]);
    if (candidateMerged.length <= maxChunkChars) {
      currentGroup.push(entry);
    } else {
      groups.push(currentGroup);
      currentGroup = [entry];
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  const baseId = extractVideoKey(unit.videoId);
  return groups.map((group) => {
    const content = mergeVideoParts(group.map((e) => e.text));
    const firstStem = group[0].stem;
    const lastStem = group[group.length - 1].stem;
    const chunkVideoId = groups.length === 1
      ? unit.videoId
      : group.length === 1
        ? `${baseId}/${firstStem}`
        : `${baseId}/${firstStem}-${lastStem}`;
    return {
      videoId: chunkVideoId,
      sourceGroup: unit.sourceGroup,
      partPaths: group.map((e) => e.path),
      sourcePath: group.length === 1 ? group[0].path : unit.sourcePath,
      content,
      sha256: sha256Hex(content),
      partCount: group.length,
    };
  });
}

export async function resolveSingleVideoInput(
  inputPath: string,
  options: { videoIdOverride?: string; mergeSiblingParts?: boolean } = {},
): Promise<VideoUnit> {
  const absPath = resolve(inputPath);
  const info = await stat(absPath);

  if (info.isDirectory()) {
    const files = (await readdir(absPath, { withFileTypes: true }))
      .filter((f) => f.isFile() && extname(f.name).toLowerCase() === ".md")
      .map((f) => f.name)
      .sort((a, b) => NATURAL_COLLATOR.compare(a, b));
    if (files.length === 0) throw new Error(`视频目录中未找到 .md 文稿：${absPath}`);
    const parentName = basename(dirname(absPath)).toLowerCase();
    const defaultId = parentName === "youtube" ? `youtube/${basename(absPath)}` : basename(absPath);
    return {
      videoId: options.videoIdOverride ?? defaultId,
      sourceGroup: parentName === "youtube" ? "youtube" : "by_bv",
      partPaths: files.map((f) => join(absPath, f)),
      sourcePath: absPath,
    };
  }

  const parentDir = dirname(absPath);
  const parentName = basename(parentDir);
  const grandParentName = basename(dirname(parentDir)).toLowerCase();
  const fileStem = basename(absPath, extname(absPath));

  if (options.mergeSiblingParts && /^P\d+$/i.test(fileStem)) {
    const siblings = (await readdir(parentDir, { withFileTypes: true }))
      .filter((f) => f.isFile() && extname(f.name).toLowerCase() === ".md")
      .map((f) => f.name)
      .sort((a, b) => NATURAL_COLLATOR.compare(a, b));
    const defaultId = grandParentName === "youtube" ? `youtube/${parentName}` : parentName;
    return {
      videoId: options.videoIdOverride ?? defaultId,
      sourceGroup: grandParentName === "youtube" ? "youtube" : "by_bv",
      partPaths: siblings.map((f) => join(parentDir, f)),
      sourcePath: parentDir,
    };
  }

  const defaultId = parentName.toLowerCase() === "audio"
    ? `audio/${fileStem}`
    : grandParentName === "youtube"
      ? `youtube/${parentName}`
      : /^P\d+$/i.test(fileStem)
        ? parentName
        : `${parentName}/${fileStem}`;

  return {
    videoId: options.videoIdOverride ?? defaultId,
    sourceGroup: "single",
    partPaths: [absPath],
    sourcePath: absPath,
  };
}

export function queryProcessedVideoIndex(store: DataMakerStore): {
  processedVideoKeys: Set<string>;
  processedSha256s: Set<string>;
} {
  const rows = store.listProcessedVideoRows();
  const processedVideoKeys = new Set<string>();
  const processedSha256s = new Set<string>();
  for (const row of rows) {
    processedVideoKeys.add(extractVideoKey(row.video_id));
    processedSha256s.add(row.sha256);
  }
  return { processedVideoKeys, processedSha256s };
}

export function summarizeCorpusStatus(units: VideoUnit[], store: DataMakerStore): CorpusStatus {
  const { processedVideoKeys } = queryProcessedVideoIndex(store);
  let totalPartFiles = 0;
  let multiPartVideos = 0;
  const unprocessed: VideoUnit[] = [];

  for (const unit of units) {
    totalPartFiles += unit.partPaths.length;
    if (unit.partPaths.length > 1) multiPartVideos++;
    if (!processedVideoKeys.has(extractVideoKey(unit.videoId))) {
      unprocessed.push(unit);
    }
  }

  return {
    totalVideos: units.length,
    totalPartFiles,
    multiPartVideos,
    processedVideos: units.length - unprocessed.length,
    unprocessedVideos: unprocessed.length,
    unprocessed,
  };
}

export type VideoSortMode = "id" | "core-first";

export function validateVideoSortMode(raw: string | undefined): VideoSortMode {
  if (raw === undefined || raw === "id") return "id";
  if (raw === "core-first") return "core-first";
  throw new Error("--sort 必须是 id 或 core-first");
}

export async function rankVideosCoreFirst(units: VideoUnit[]): Promise<VideoUnit[]> {
  const scored = await Promise.all(
    units.map(async (unit) => {
      let totalBytes = 0;
      for (const partPath of unit.partPaths) {
        try {
          totalBytes += (await stat(partPath)).size;
        } catch {
          // Ignore unreadable/missing part during stat ranking
        }
      }
      const tier = totalBytes >= 6_000
        ? (unit.partPaths.length >= 2 ? 2 : 1)
        : 0;
      return { unit, tier, totalBytes };
    }),
  );

  scored.sort((a, b) =>
    b.tier - a.tier
    || b.totalBytes - a.totalBytes
    || NATURAL_COLLATOR.compare(a.unit.videoId, b.unit.videoId),
  );
  return scored.map((item) => item.unit);
}

export function selectVideos(
  unprocessed: VideoUnit[],
  options: {
    limit?: number;
    shuffle?: boolean;
    rng?: () => number;
    split?: DatasetSplit;
    store?: DataMakerStore;
    splitMap?: Map<string, { split: DatasetSplit }>;
  } = {},
): VideoUnit[] {
  const targetSplit = options.split !== undefined ? validateSplit(options.split) : undefined;
  const pool = targetSplit === undefined
    ? [...unprocessed]
    : unprocessed.filter((unit) => {
        const videoKey = extractVideoKey(unit.videoId);
        const assigned = options.splitMap?.get(videoKey)?.split
          ?? options.store?.getVideoSplit(videoKey)?.split
          ?? computeVideoSplit(videoKey);
        return assigned === targetSplit;
      });
  if (options.shuffle) {
    const rng = options.rng ?? Math.random;
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }
  if (options.limit !== undefined) {
    return pool.slice(0, options.limit);
  }
  return pool;
}
