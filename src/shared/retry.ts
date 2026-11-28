import { rethrowIfAborted, throwIfAborted } from "./cancellation.js";

export const DEFAULT_CALL_MAX_ATTEMPTS = 3;
export const DEFAULT_CALL_RETRY_DELAY_MS = 3000;

export function validateCallMaxAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new Error("callMaxAttempts 必须是 1–10 的整数");
  }
  return value;
}

export function validateCallRetryDelayMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new Error("callRetryDelayMs 必须是 0–60000 的整数（毫秒）");
  }
  return value;
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      try { throwIfAborted(signal); } catch (error) { reject(error); }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runWithRetry<T>(options: {
  maxAttempts: number;
  delayMs: number;
  signal?: AbortSignal;
  run: (attempt: number, signal?: AbortSignal) => Promise<T>;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (attempt: number, maxAttempts: number, error: unknown) => void;
}): Promise<T> {
  const maxAttempts = validateCallMaxAttempts(options.maxAttempts);
  const delayMs = validateCallRetryDelayMs(options.delayMs);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      throwIfAborted(options.signal);
      const result = await options.run(attempt, options.signal);
      throwIfAborted(options.signal);
      return result;
    } catch (error) {
      rethrowIfAborted(error, options.signal);
      lastError = error;
      const canRetry = attempt < maxAttempts && (options.shouldRetry ? options.shouldRetry(error, attempt) : true);
      if (!canRetry) {
        throw error;
      }
      options.onRetry?.(attempt, maxAttempts, error);
      await sleep(delayMs, options.signal);
    }
  }

  throw lastError;
}
