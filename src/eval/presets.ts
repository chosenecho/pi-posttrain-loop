import type { EvalHistoryMode, EvalProfile } from "./store/index.js";

export type EvalImportPresetName = "test-fresh";

export interface EvalImportPreset {
  name: EvalImportPresetName;
  description: string;
  limit: number;
  shuffle: boolean;
  seed: number;
  excludeUsed: boolean;
}

export const EVAL_IMPORT_PRESETS: Record<EvalImportPresetName, EvalImportPreset> = {
  "test-fresh": {
    name: "test-fresh",
    description: "从主库 test 分区随机抽取 10 个未用视频快照（seed=42）",
    limit: 10,
    shuffle: true,
    seed: 42,
    excludeUsed: true,
  },
};

export function resolveEvalImportPreset(raw: string | undefined): EvalImportPreset | undefined {
  if (raw === undefined) return undefined;
  const key = raw.trim().toLowerCase() as EvalImportPresetName;
  if (!(key in EVAL_IMPORT_PRESETS)) {
    throw new Error(`未知 eval import 预设：${raw}（可选：${Object.keys(EVAL_IMPORT_PRESETS).join(", ")}）`);
  }
  return EVAL_IMPORT_PRESETS[key];
}

export type EvalBuildPresetName = "adv-full" | "adv-fast" | "trap";

export interface EvalBuildPreset {
  name: EvalBuildPresetName;
  description: string;
  profile: EvalProfile;
  probesPerVideo: number;
  bareCheck: boolean;
  maxBareRefinements: number;
  concurrency: number;
}

export const EVAL_BUILD_PRESETS: Record<EvalBuildPresetName, EvalBuildPreset> = {
  "adv-full": {
    name: "adv-full",
    description: "正式对抗考题构建（adversarial + 每视频上限 6 题 + 开启裸答对抗回流 + 并发 8）",
    profile: "adversarial",
    probesPerVideo: 6,
    bareCheck: true,
    maxBareRefinements: 1,
    concurrency: 8,
  },
  "adv-fast": {
    name: "adv-fast",
    description: "快速对抗考题构建（adversarial + 每视频上限 6 题 + 关闭裸答回流 + 并发 8）",
    profile: "adversarial",
    probesPerVideo: 6,
    bareCheck: false,
    maxBareRefinements: 0,
    concurrency: 8,
  },
  trap: {
    name: "trap",
    description: "陷阱拒答专项考题构建（trap + 每视频上限 3 题 + 开启裸答回流 + 并发 8）",
    profile: "trap",
    probesPerVideo: 3,
    bareCheck: true,
    maxBareRefinements: 1,
    concurrency: 8,
  },
};

export function resolveEvalBuildPreset(raw: string | undefined): EvalBuildPreset | undefined {
  if (raw === undefined) return undefined;
  const key = raw.trim().toLowerCase() as EvalBuildPresetName;
  if (!(key in EVAL_BUILD_PRESETS)) {
    throw new Error(`未知 eval build 预设：${raw}（可选：${Object.keys(EVAL_BUILD_PRESETS).join(", ")}）`);
  }
  return EVAL_BUILD_PRESETS[key];
}

export type EvalRunPresetName = "blind-gold" | "blind-self";

export interface EvalRunPreset {
  name: EvalRunPresetName;
  description: string;
  historyMode: EvalHistoryMode;
  concurrency: number;
}

export const EVAL_RUN_PRESETS: Record<EvalRunPresetName, EvalRunPreset> = {
  "blind-gold": {
    name: "blind-gold",
    description: "标准脱稿盲测（gold 历史模式 + 并发 4，适合跨模型横向对比）",
    historyMode: "gold",
    concurrency: 4,
  },
  "blind-self": {
    name: "blind-self",
    description: "真实自回归多轮脱稿盲测（self 历史模式 + 并发 4）",
    historyMode: "self",
    concurrency: 4,
  },
};

export function resolveEvalRunPreset(raw: string | undefined): EvalRunPreset | undefined {
  if (raw === undefined) return undefined;
  const key = raw.trim().toLowerCase() as EvalRunPresetName;
  if (!(key in EVAL_RUN_PRESETS)) {
    throw new Error(`未知 eval run 预设：${raw}（可选：${Object.keys(EVAL_RUN_PRESETS).join(", ")}）`);
  }
  return EVAL_RUN_PRESETS[key];
}
