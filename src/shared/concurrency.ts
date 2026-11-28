import { throwIfAborted } from "./cancellation.js";
import { PublicError } from "./public-error.js";

/**
 * Shared concurrency pool and per-key warmup gate for LLM batch pipelines.
 * Keeps prefix-cache warmup serialized for the first call per key before fanning out.
 */

export interface WarmupGate {
  run<T>(key: string, enabled: boolean, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/**
 * Serializes only the first concurrent call for a given `key` so upstream KV prefix
 * caches get populated once before remaining workers fan out in parallel.
 */
export function createWarmupGate(): WarmupGate {
  const gates = new Map<string, Promise<void>>();
  return {
    async run<T>(key: string, enabled: boolean, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      throwIfAborted(signal);
      if (!enabled) return fn();
      const existing = gates.get(key);
      if (existing) {
        await waitForWarmup(existing, signal);
        throwIfAborted(signal);
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

/** Cancels only this waiter; the owner remains awaited by its own pool worker. */
async function waitForWarmup(gate: Promise<void>, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      try { throwIfAborted(signal); } catch (error) { reject(error); }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void gate.then(() => { cleanup(); resolve(); }, (error) => { cleanup(); reject(error); });
  });
}

/**
 * Unhandled worker errors are fatal: stop dispatch, abort peers, then await their real cleanup.
 * A worker handles an item-local failure by recording it and returning normally.
 * Cooperative cancellation is required; an ignoring worker keeps this promise pending.
 */
export async function runConcurrentPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number, signal: AbortSignal) => Promise<void>,
  options: { signal?: AbortSignal; onSecondaryError?: (error: unknown) => void } = {},
): Promise<void> {
  throwIfAborted(options.signal);
  if (items.length === 0) return;
  const controller = new AbortController();
  let failed = false;
  let primary: unknown;
  const secondary: unknown[] = [];
  const stop = (error: unknown) => {
    if (failed) { secondary.push(error); return; }
    failed = true;
    primary = error;
    controller.abort(new PublicError("operation_aborted"));
  };
  const onAbort = () => {
    try { throwIfAborted(options.signal); } catch (error) { stop(error); }
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  let cursor = 0;
  async function next(): Promise<void> {
    while (!failed) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try { await worker(items[idx]!, idx, controller.signal); }
      catch (error) { stop(error); return; }
    }
  }
  try {
    await Promise.allSettled(Array.from({ length: workerCount }, () => next()));
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
  // Diagnostics happen only after drain so a reporting failure cannot skip cleanup.
  for (const error of secondary) {
    try { options.onSecondaryError?.(error); } catch { /* Preserve the primary failure. */ }
  }
  if (failed) throw primary;
}
