import { PublicError } from "./public-error.js";

export function isOperationAborted(error: unknown): error is PublicError {
  return error instanceof PublicError && error.code === "operation_aborted";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  // Only our structured cancellation reasons are exposed. Arbitrary AbortSignal reasons stay private.
  if (signal.reason instanceof PublicError &&
      (signal.reason.code === "operation_aborted" || signal.reason.code === "model_timeout")) {
    throw signal.reason;
  }
  throw new PublicError("operation_aborted");
}

/** Cancellation and failed adapter cleanup both terminate item-local handling. */
export function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
  if (error instanceof PublicError && error.code === "adapter_cleanup_failed") throw error;
  throwIfAborted(signal);
  if (isOperationAborted(error)) throw error;
}

/** Parent cancellation and this attempt's deadline retain distinct structured reasons. */
export function createAttemptCancellation(parent?: AbortSignal, timeoutMs?: number) {
  const controller = new AbortController();
  const cancelFromParent = () => {
    if (!controller.signal.aborted) {
      // Nested simulators inherit an attempt timeout without reclassifying it as user cancellation.
      const reason = parent?.reason;
      controller.abort(reason instanceof PublicError && reason.code === "model_timeout"
        ? reason : new PublicError("operation_aborted"));
    }
  };
  if (parent?.aborted) cancelFromParent();
  else parent?.addEventListener("abort", cancelFromParent, { once: true });
  const timer = timeoutMs === undefined || controller.signal.aborted ? undefined : setTimeout(() => {
    controller.abort(new PublicError("model_timeout"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", cancelFromParent);
    },
  };
}

export function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  return first && second ? AbortSignal.any([first, second]) : first ?? second;
}
