import type {
  DatasetSplit,
  FollowupDecision,
  Material,
  Review,
  SynthProfile,
} from "./types.js";

export function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

export function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value.trim();
}

export function parseJson(text: string): unknown {
  // Accept one complete fenced JSON block, but never guess at partial JSON.
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed) as unknown;
  } catch {
    throw new Error("模型输出不是完整有效的 JSON；原始输出已保存在 trace");
  }
}

export function parseQuestions(text: string): string[] {
  const value = asObject(parseJson(text), "出题结果");
  if (!Array.isArray(value.questions) || value.questions.length > 3) {
    throw new Error("出题结果必须包含 questions 数组，长度为 0–3");
  }
  const questions = value.questions.map((item, index) =>
    nonEmpty(item, `questions[${index}]`),
  );
  if (new Set(questions).size !== questions.length) {
    throw new Error("出题结果包含重复问题");
  }
  return questions;
}

export function parseReview(text: string): Review {
  const value = asObject(parseJson(text), "质检结果");
  const { decision, issues, feedback } = value;
  if (decision !== "pass" && decision !== "revise" && decision !== "drop") {
    throw new Error("质检 decision 必须为 pass、revise 或 drop");
  }
  if (!Array.isArray(issues) || !issues.every((issue) => typeof issue === "string")) {
    throw new Error("质检 issues 必须是字符串数组");
  }
  if (typeof feedback !== "string") {
    throw new Error("质检 feedback 必须是字符串");
  }
  if (decision === "revise" && !feedback.trim()) {
    throw new Error("revise 必须附带非空 feedback");
  }
  if (decision === "pass" && issues.length > 0) {
    throw new Error("pass 的 issues 必须为空数组");
  }
  if (decision === "drop" && issues.length === 0 && !feedback.trim()) {
    throw new Error("drop 必须说明跳过原因");
  }
  return { decision, issues, feedback: feedback.trim() };
}

export function parseMaterial(value: unknown): Material {
  const object = asObject(value, "材料");
  return { id: nonEmpty(object.id, "材料 id"), text: nonEmpty(object.text, "材料 text") };
}

export function validateMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error("max-attempts 必须是 1–10 的整数（包含首次回答）");
  }
  return value;
}

export function validateMaxTurns(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new Error("max-turns 必须是 1–20 的整数");
  }
  return value;
}

export function validateConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error("concurrency 必须是 1–500 的整数");
  }
  return value;
}

export function parseFollowup(text: string): FollowupDecision {
  const value = asObject(parseJson(text), "追问结果");
  if (value.action === "stop") {
    return { action: "stop" };
  }
  if (value.action === "followup") {
    return { action: "followup", user: nonEmpty(value.user, "追问 user") };
  }
  throw new Error("追问 action 必须为 followup 或 stop");
}

export function validateSplit(value: unknown, label = "split"): DatasetSplit {
  if (value !== "train" && value !== "test" && value !== "dpo") {
    throw new Error(`${label} 必须为 train、test 或 dpo`);
  }
  return value;
}

export function parseSynthProfile(raw: string | undefined): SynthProfile {
  const value = (raw ?? "standard").trim().toLowerCase();
  if (value === "standard" || value === "short" || value === "trap") return value;
  throw new Error(`--profile 仅支持 standard、short 或 trap，当前值：${raw}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
