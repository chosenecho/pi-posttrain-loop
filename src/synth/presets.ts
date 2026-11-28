import type { DatasetSplit, SynthProfile } from "../shared/types.js";
import type { VideoSortMode } from "./corpus.js";

export type SynthRunPresetName =
  | "train-standard"
  | "train-short"
  | "train-medium"
  | "train-long"
  | "train-xlong"
  | "train-trap"
  | "train-search"
  | "train-todo"
  | "train-clarify"
  | "dpo-pool";

export interface SynthRunPreset {
  name: SynthRunPresetName;
  description: string;
  split: DatasetSplit;
  profile: SynthProfile;
  sort?: VideoSortMode;
  shuffle?: boolean;
  maxTurns: number;
  maxQuestionsPerVideo?: number;
}

export const SYNTH_RUN_PRESETS: Record<SynthRunPresetName, SynthRunPreset> = {
  "train-standard": {
    name: "train-standard",
    description: "训练集标准综合预设（历史兼容，train 分区 + standard Skill + core-first + 3 轮）",
    split: "train",
    profile: "standard",
    sort: "core-first",
    maxTurns: 3,
  },
  "train-short": {
    name: "train-short",
    description: "训练集短答预设（Easy 档组成，train 分区 + short Skill + core-first + 最多 2 轮）",
    split: "train",
    profile: "short",
    sort: "core-first",
    maxTurns: 2,
  },
  "train-medium": {
    name: "train-medium",
    description: "训练集中等长度预设（Easy 档组成，train 分区 + medium Skill + core-first + 最多 2 轮）",
    split: "train",
    profile: "medium",
    sort: "core-first",
    maxTurns: 2,
  },
  "train-long": {
    name: "train-long",
    description: "训练集长答预设（Medium 进阶档，train 分区 + long Skill + core-first + 最多 3 轮）",
    split: "train",
    profile: "long",
    sort: "core-first",
    maxTurns: 3,
  },
  "train-xlong": {
    name: "train-xlong",
    description: "训练集超长深挖预设（Hard 高难档组成，train 分区 + xlong Skill + core-first + 最多 3 轮）",
    split: "train",
    profile: "xlong",
    sort: "core-first",
    maxTurns: 3,
  },
  "train-trap": {
    name: "train-trap",
    description: "训练集陷阱拒答预设（Hard 高难档组成，train 分区 + trap Skill + core-first + 最多 2 轮 + 上限 2 题）",
    split: "train",
    profile: "trap",
    sort: "core-first",
    maxTurns: 2,
    maxQuestionsPerVideo: 2,
  },
  "train-search": {
    name: "train-search",
    description: "训练集独立搜索考证专项预设（联网搜证后回答，train 分区 + search Skill + core-first + 最多 2 轮 + 上限 2 题）",
    split: "train",
    profile: "search",
    sort: "core-first",
    maxTurns: 2,
    maxQuestionsPerVideo: 2,
  },
  "train-todo": {
    name: "train-todo",
    description: "训练集长流程规划预设（Pi todo 工具拆解 + 按需搜索，train 分区 + todo Skill + core-first + 最多 2 轮 + 上限 2 题）",
    split: "train",
    profile: "todo",
    sort: "core-first",
    maxTurns: 2,
    maxQuestionsPerVideo: 2,
  },
  "train-clarify": {
    name: "train-clarify",
    description: "训练集反问澄清预设（Pi question/questionnaire 追问 + 用户模拟器，train 分区 + clarify Skill + core-first + 最多 2 轮 + 上限 2 题）",
    split: "train",
    profile: "clarify",
    sort: "core-first",
    maxTurns: 2,
    maxQuestionsPerVideo: 2,
  },
  "dpo-pool": {
    name: "dpo-pool",
    description: "DPO 采题池预设（dpo 分区 + 随机抽选 + 3 轮）",
    split: "dpo",
    profile: "standard",
    shuffle: true,
    maxTurns: 3,
  },
};

export function resolveSynthRunPreset(raw: string | undefined): SynthRunPreset | undefined {
  if (raw === undefined) return undefined;
  const key = raw.trim().toLowerCase() as SynthRunPresetName;
  if (!(key in SYNTH_RUN_PRESETS)) {
    throw new Error(`未知 synth 预设：${raw}（可选：${Object.keys(SYNTH_RUN_PRESETS).join(", ")}）`);
  }
  return SYNTH_RUN_PRESETS[key];
}

/**
 * Three-difficulty & tool-paradigm suite presets for `synth suite` so users can run
 * Easy (`short`+`medium`), Medium (`long`), Hard (`xlong`+`trap`), Todo (`todo`), or Clarify (`clarify`).
 */
export const SYNTH_TIER_PROFILES: Record<"easy" | "medium" | "hard" | "todo" | "clarify" | "search" | "all", readonly SynthProfile[]> = {
  easy: ["short", "medium"],
  medium: ["long"],
  hard: ["xlong", "trap"],
  todo: ["todo"],
  clarify: ["clarify"],
  search: ["search"],
  all: ["short", "medium", "long", "xlong", "trap", "search", "todo", "clarify"],
};

export type SynthExportPresetName = "train-val" | "train-all";

export interface SynthExportPreset {
  name: SynthExportPresetName;
  description: string;
  allFormal: boolean;
  split: DatasetSplit;
  shuffle?: boolean;
  seed?: number;
  valRatio?: number;
  timestamp?: boolean;
}

export const SYNTH_EXPORT_PRESETS: Record<SynthExportPresetName, SynthExportPreset> = {
  "train-all": {
    name: "train-all",
    description: "汇总全库正式训练样本并附加时间戳",
    allFormal: true,
    split: "train",
    timestamp: true,
  },
  "train-val": {
    name: "train-val",
    description: "汇总全库正式训练样本，固定种子打乱 + 按视频切 10% 验证集 + 时间戳",
    allFormal: true,
    split: "train",
    shuffle: true,
    seed: 42,
    valRatio: 0.1,
    timestamp: true,
  },
};

export function resolveSynthExportPreset(raw: string | undefined): SynthExportPreset | undefined {
  if (raw === undefined) return undefined;
  const key = raw.trim().toLowerCase() as SynthExportPresetName;
  if (!(key in SYNTH_EXPORT_PRESETS)) {
    throw new Error(`未知 export 预设：${raw}（可选：${Object.keys(SYNTH_EXPORT_PRESETS).join(", ")}）`);
  }
  return SYNTH_EXPORT_PRESETS[key];
}
