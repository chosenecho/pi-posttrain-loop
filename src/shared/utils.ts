import { createHash } from "node:crypto";

/**
 * Normalizes a video_id into its canonical videoKey so all multi-P chunks
 * (`BVxxxx/P001-P004`, `BVxxxx/P005`) resolve to the exact same key (`BVxxxx`).
 */
export function extractVideoKey(videoId: string): string {
  return videoId.replace(/\/P\d+(?:-P\d+)?$/i, "");
}

export function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Deterministic Mulberry32 PRNG in [0, 1). */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
