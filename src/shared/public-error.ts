const PUBLIC_ERROR_MESSAGES = {
  unexpected_error: "内部处理失败",
  operation_aborted: "操作已取消",
  adapter_cleanup_failed: "适配器清理失败",
  tool_limit_reached: "工具调用次数已达上限",
  tool_arguments_invalid: "工具参数校验失败",
  tool_execution_failed: "工具执行失败",
  model_request_failed: "模型请求失败",
  model_timeout: "模型请求超时",
  model_missing_message: "模型未返回 assistant 消息",
  model_incomplete: "模型响应未完整结束",
  model_empty_output: "模型返回空正文",
  model_tool_missing_receipt: "工具调用未返回回执",
  model_tool_failed: "模型工具执行失败",
  model_save_tool_missing: "模型未调用保存工具，尚未入库",
  model_output_invalid: "模型输出格式校验失败",
  candidate_request_failed: "候选模型请求失败",
  candidate_http_error: "候选模型 HTTP 请求失败",
  candidate_html_response: "候选模型接口返回 HTML 而非 API JSON",
  candidate_invalid_json: "候选模型接口返回非合法 JSON",
  candidate_api_error: "候选模型接口报告错误",
  candidate_missing_choice: "候选模型接口响应缺少 choices[0]",
  candidate_empty_output: "候选模型返回空正文",
} as const;

export type PublicErrorCode = keyof typeof PUBLIC_ERROR_MESSAGES;

const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted", "pending", "content_filter", "tool_calls", "function_call"]);

interface PublicErrorDetails {
  httpStatus?: number;
  stopReason?: unknown;
}

function validHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/** A diagnostic whose public text is built only from application-owned labels and bounded metadata. */
export class PublicError extends Error {
  readonly code: PublicErrorCode;
  readonly httpStatus?: number;
  readonly stopReason?: string;

  constructor(code: PublicErrorCode, details: PublicErrorDetails = {}) {
    const safeCode = Object.hasOwn(PUBLIC_ERROR_MESSAGES, code) ? code : "unexpected_error";
    const httpStatus = validHttpStatus(details.httpStatus);
    const stopReason = typeof details.stopReason === "string" && STOP_REASONS.has(details.stopReason)
      ? details.stopReason
      : undefined;
    const metadata = [httpStatus === undefined ? undefined : `HTTP ${httpStatus}`, stopReason].filter(Boolean);
    super(`${PUBLIC_ERROR_MESSAGES[safeCode]} [${safeCode}]${metadata.length ? ` (${metadata.join(", ")})` : ""}`);
    this.name = "PublicError";
    this.code = safeCode;
    this.httpStatus = httpStatus;
    this.stopReason = stopReason;
  }
}

/** Use structured status only; provider messages, names, causes, bodies and statusText stay private. */
export function toPublicError(error: unknown, fallback: PublicErrorCode = "unexpected_error"): PublicError {
  if (error instanceof PublicError) return error;
  let httpStatus: number | undefined;
  try {
    if (error !== null && typeof error === "object" && "status" in error) {
      httpStatus = validHttpStatus(error.status);
    }
  } catch {
    // An unknown thrown value can even have a throwing property getter.
  }
  return new PublicError(fallback, { httpStatus });
}

export function publicErrorMessage(error: unknown): string {
  const safe = toPublicError(error);
  // Rebuild rather than trusting Error.message, which callers can mutate.
  return new PublicError(safe.code, { httpStatus: safe.httpStatus, stopReason: safe.stopReason }).message;
}
