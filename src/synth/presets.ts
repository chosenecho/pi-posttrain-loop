import type { DatasetSplit, SynthProfile } from "../shared/types.js";
import type { VideoSortMode } from "./corpus.js";

export type SynthRunPresetName =
  | "train-standard"
  | "train-short"
  | "train-trap"
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
    description: "训练集标准深挖预设（train 分区 + standard Skill + core-first 排序 + 3 轮）",
    split: "train",
    profile: "standard",
    sort: "core-first",
    maxTurns: 3,
  },
  "train-short": {
    name: "train-short",
    description: "训练集短答快问预设（train 分区 + short Skill + 随机抽选 + 2 轮）",
    split: "train",
    profile: "short",
    shuffle: true,
    maxTurns: 2,
  },
  "train-trap": {
    name: "train-trap",
    description: "训练集陷阱拒答预设（train 分区 + trap Skill + 随机抽选 + 2 轮 + 上限 3 题）",
    split: "train",
    profile: "trap",
    shuffle: true,
    maxTurns: 2,
    maxQuestionsPerVideo: 3,
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
