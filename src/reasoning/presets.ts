import type { DatasetSplit } from "../shared/types.js";
import type { ProfileFilter } from "./checks.js";
import type { ReasoningExportFormat } from "./export.js";

export type CotBackfillPresetName = "pilot" | "full";

export interface CotBackfillPreset {
  name: CotBackfillPresetName;
  description: string;
  limit?: number;
  stratified?: boolean;
  seed?: number;
  onlyMissing: boolean;
  concurrency?: number;
  profile?: ProfileFilter;
}

export const COT_BACKFILL_PRESETS: Record<CotBackfillPresetName, CotBackfillPreset> = {
  pilot: {
    name: "pilot",
    description: "30 轮分层试点（按档位×轮次均衡抽样，默认 seed=42，跳过已通过轮次）",
    limit: 30,
    stratified: true,
    seed: 42,
    onlyMissing: true,
    concurrency: 10,
  },
  full: {
    name: "full",
    description: "全量增量补写（自动跳过已通过质检的轮次，默认并发 10）",
    onlyMissing: true,
    concurrency: 10,
  },
};

export function resolveCotBackfillPreset(raw: string | undefined): CotBackfillPreset | undefined {
  if (raw === undefined) return undefined;
  const key = raw.trim().toLowerCase() as CotBackfillPresetName;
  if (!(key in COT_BACKFILL_PRESETS)) {
    throw new Error(`未知 cot backfill 预设：${raw}（可选：${Object.keys(COT_BACKFILL_PRESETS).join(", ")}）`);
  }
  return COT_BACKFILL_PRESETS[key];
}

export type CotExportPresetName = "train-cot" | "train-cot-val";

export interface CotExportPreset {
  name: CotExportPresetName;
  description: string;
  split: DatasetSplit;
  format: ReasoningExportFormat;
  expandTurns: boolean;
  shuffle?: boolean;
  seed?: number;
  valRatio?: number;
}

export const COT_EXPORT_PRESETS: Record<CotExportPresetName, CotExportPreset> = {
  "train-cot": {
    name: "train-cot",
    description: "按轮展开、inline 格式导出全库正式训练集 CoT 样本（适配 ms-swift 4.6.0）",
    split: "train",
    format: "inline",
    expandTurns: true,
  },
  "train-cot-val": {
    name: "train-cot-val",
    description: "按轮展开、inline 格式导出，固定种子打乱并按视频切出 10% 验证集",
    split: "train",
    format: "inline",
    expandTurns: true,
    shuffle: true,
    seed: 42,
    valRatio: 0.1,
  },
};

export function resolveCotExportPreset(raw: string | undefined): CotExportPreset | undefined {
  if (raw === undefined) return undefined;
  const key = raw.trim().toLowerCase() as CotExportPresetName;
  if (!(key in COT_EXPORT_PRESETS)) {
    throw new Error(`未知 cot export 预设：${raw}（可选：${Object.keys(COT_EXPORT_PRESETS).join(", ")}）`);
  }
  return COT_EXPORT_PRESETS[key];
}
