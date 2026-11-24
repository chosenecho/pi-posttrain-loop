/**
 * Shared concurrency pool and per-key warmup gate for LLM batch pipelines.
 * Keeps prefix-cache warmup serialized for the first call per key before fanning out.
 */

export interface WarmupGate {
  run<T>(key: string, enabled: boolean, fn: () => Promise<T>): Promise<T>;
}

/**
 * Serializes only the first concurrent call for a given `key` so upstream KV prefix
 * caches get populated once before remaining workers fan out in parallel.
 */
export function createWarmupGate(): WarmupGate {
  const gates = new Map<string, Promise<void>>();
  return {
    async run<T>(key: string, enabled: boolean, fn: () => Promise<T>): Promise<T> {
      if (!enabled) return fn();
      const existing = gates.get(key);
      if (existing) {
        await existing;
        return fn();
      }
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.set(key, gate);
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

/** Runs `worker` over `items` with at most `concurrency` active promises. */
export async function runConcurrentPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  async function next(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => next()));
}
