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

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWithRetry<T>(options: {
  maxAttempts: number;
  delayMs: number;
  run: (attempt: number) => Promise<T>;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (attempt: number, maxAttempts: number, error: unknown) => void;
}): Promise<T> {
  const maxAttempts = validateCallMaxAttempts(options.maxAttempts);
  const delayMs = validateCallRetryDelayMs(options.delayMs);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await options.run(attempt);
    } catch (error) {
      lastError = error;
      const canRetry = attempt < maxAttempts && (options.shouldRetry ? options.shouldRetry(error, attempt) : true);
      if (!canRetry) {
        throw error;
      }
      options.onRetry?.(attempt, maxAttempts, error);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
