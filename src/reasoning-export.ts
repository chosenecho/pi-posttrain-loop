import { createSeededRng, sha256Hex, type DedupPolicy } from "./db.js";
import {
  computeBatchStats,
  countContentChars,
  type ProfileFilter,
  type ReasoningBatchStats,
  type RuleCheckMetrics,
  type SourceProfile,
  type ThinkTier,
  type TraceStatInput,
} from "./reasoning-checks.js";
import {
  ReasoningStore,
  type CandidateTurn,
  type ReasoningRunRecord,
  type TraceWithContext,
} from "./reasoning-store.js";
import { nonEmpty } from "./schema.js";
import type { DatasetSplit } from "./types.js";

export type ReasoningExportFormat = "reasoning_content" | "inline";

export interface ReasoningTrainingMessage {
  role: "system" | "user" | "assistant";
  content: string;
  reasoning_content?: string;
}

export interface ReasoningTrainingSampleLine {
  messages: ReasoningTrainingMessage[];
}

export interface ReasoningExportRecord {
  resultId: number;
  sourceRunId: number;
  sourceProfile: SourceProfile;
  questionId: number;
  materialId: number;
  videoKey: string;
  turnNo: number;
  turnCount: number;
  attemptId: number;
  reasoningRunId: number;
  lengthTier: ThinkTier;
  sample: ReasoningTrainingSampleLine;
}

export interface ReasoningExportOptions {
  /** Specific reasoning_run_id; omit to use the latest passed trace per attempt_id across all reasoning runs. */
  reasoningRunId?: number;
  allFormal?: boolean;
  runIds?: number[];
  excludeRunIds?: number[];
  split?: DatasetSplit;
  profile?: ProfileFilter;
  tiers?: ThinkTier[];
  dedup?: DedupPolicy;
  minTurns?: number;
  maxTurns?: number;
  /** Default true: expands multi-turn dialogues into per-turn samples (history pure text, only final turn carries CoT). */
  expandTurns?: boolean;
  /** Default "inline": embeds `<think>\n...\n</think>\n\n` in content (required by ms-swift 4.6.0 Qwen3_8Template); "reasoning_content" is for direct HF apply_chat_template. */
  format?: ReasoningExportFormat;
  systemPrompt?: string;
  shuffle?: boolean;
  seed?: number;
  valRatio?: number;
}

export interface ReasoningExportResult {
  train: ReasoningExportRecord[];
  val: ReasoningExportRecord[];
  skippedMissingTurns: number;
  skippedDialogues: number;
  includedSourceRunIds: number[];
  includedReasoningRunIds: number[];
  profileDistribution: Record<SourceProfile, number>;
  turnNoDistribution: Record<number, number>;
  tierDistribution: Record<ThinkTier, number>;
  materialCount: number;
  trainVideoCount: number;
  valVideoCount: number;
  expandTurns: boolean;
  format: ReasoningExportFormat;
}

export function formatAssistantWithReasoning(
  content: string,
  reasoning: string,
  format: ReasoningExportFormat,
): ReasoningTrainingMessage {
  const cleanReasoning = reasoning.trim();
  if (format === "inline") {
    return {
      role: "assistant",
      content: `<think>\n${cleanReasoning}\n</think>\n\n${content}`,
    };
  }
  return {
    role: "assistant",
    reasoning_content: cleanReasoning,
    content,
  };
}

export function formatReasoningJsonl(samples: ReasoningTrainingSampleLine[]): string {
  if (samples.length === 0) return "";
  return samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n";
}

function shuffleInPlace<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * Exports ms-swift-ready CoT training JSONL from unified SQLite.
 *
 * When `expandTurns` is true (recommended for Qwen thinking models with `ms-swift --loss_scale last_round`),
 * a K-turn dialogue is expanded into up to K samples where prior assistant turns are pure content
 * (zero `<think>` / `reasoning_content`) and only the final assistant turn carries the backfilled CoT.
 */
export function buildReasoningExportDataset(
  store: ReasoningStore,
  options: ReasoningExportOptions = {},
): ReasoningExportResult {
  const expandTurns = options.expandTurns ?? true;
  const format: ReasoningExportFormat = options.format ?? "inline";
  if (format !== "reasoning_content" && format !== "inline") {
    throw new Error("format 必须为 reasoning_content 或 inline");
  }
  if (options.valRatio !== undefined && (!Number.isFinite(options.valRatio) || options.valRatio <= 0 || options.valRatio >= 1)) {
    throw new Error("valRatio 必须是 (0, 1) 之间的小数");
  }
  const systemPrompt = options.systemPrompt !== undefined ? nonEmpty(options.systemPrompt, "systemPrompt") : undefined;

  if (options.reasoningRunId !== undefined) {
    const run = store.getReasoningRun(options.reasoningRunId);
    if (!run) {
      throw new Error(`未找到 reasoning_run_id=${options.reasoningRunId}`);
    }
  }

  const turns = store.queryCandidateTurns({
    allFormal: options.allFormal,
    runIds: options.runIds,
    excludeRunIds: options.excludeRunIds,
    split: options.split,
    profile: options.profile,
    tiers: options.tiers,
    dedup: options.dedup,
    minTurns: options.minTurns,
    maxTurns: options.maxTurns,
    onlyMissing: false,
  });

  const passedMap = store.getPassedReasoningMap(options.reasoningRunId);
  const records: ReasoningExportRecord[] = [];
  let skippedMissingTurns = 0;
  let skippedDialogues = 0;

  if (expandTurns) {
    for (const turn of turns) {
      const trace = passedMap.get(turn.attemptId);
      if (!trace) {
        skippedMissingTurns++;
        continue;
      }
      const messages: ReasoningTrainingMessage[] = [];
      if (systemPrompt !== undefined) {
        messages.push({ role: "system", content: systemPrompt });
      }
      // History assistant turns are strictly pure content (never carry prior <think> / reasoning_content)
      for (const h of turn.history) {
        messages.push({ role: h.role, content: h.content });
      }
      messages.push({ role: "user", content: turn.question });
      messages.push(formatAssistantWithReasoning(turn.answer, trace.reasoning, format));

      records.push({
        resultId: turn.resultId,
        sourceRunId: turn.sourceRunId,
        sourceProfile: turn.sourceProfile,
        questionId: turn.questionId,
        materialId: turn.materialId,
        videoKey: turn.videoKey,
        turnNo: turn.turnNo,
        turnCount: turn.turnCount,
        attemptId: turn.attemptId,
        reasoningRunId: trace.reasoningRunId,
        lengthTier: trace.lengthTier,
        sample: { messages },
      });
    }
  } else {
    const byResult = new Map<number, CandidateTurn[]>();
    for (const turn of turns) {
      const list = byResult.get(turn.resultId);
      if (list) list.push(turn);
      else byResult.set(turn.resultId, [turn]);
    }
    for (const dialogue of byResult.values()) {
      dialogue.sort((a, b) => a.turnNo - b.turnNo);
      const traces = dialogue.map((t) => passedMap.get(t.attemptId));
      const missingCount = traces.filter((t) => !t).length;
      if (missingCount > 0) {
        skippedDialogues++;
        skippedMissingTurns += missingCount;
        continue;
      }
      const messages: ReasoningTrainingMessage[] = [];
      if (systemPrompt !== undefined) {
        messages.push({ role: "system", content: systemPrompt });
      }
      for (let i = 0; i < dialogue.length; i++) {
        const turn = dialogue[i];
        const trace = traces[i]!;
        messages.push({ role: "user", content: turn.question });
        messages.push(formatAssistantWithReasoning(turn.answer, trace.reasoning, format));
      }
      const last = dialogue[dialogue.length - 1];
      const lastTrace = traces[traces.length - 1]!;
      records.push({
        resultId: last.resultId,
        sourceRunId: last.sourceRunId,
        sourceProfile: last.sourceProfile,
        questionId: last.questionId,
        materialId: last.materialId,
        videoKey: last.videoKey,
        turnNo: last.turnCount,
        turnCount: last.turnCount,
        attemptId: last.attemptId,
        reasoningRunId: lastTrace.reasoningRunId,
        lengthTier: lastTrace.lengthTier,
        sample: { messages },
      });
    }
  }

  const rng = options.seed !== undefined ? createSeededRng(options.seed) : Math.random;
  const allVideoKeys = [...new Set(records.map((r) => r.videoKey))].sort();
  let train: ReasoningExportRecord[];
  let val: ReasoningExportRecord[];

  if (options.valRatio !== undefined) {
    if (allVideoKeys.length < 2) {
      throw new Error("按视频切分验证集至少需要 2 个不同视频（videoKey）");
    }
    const shuffledKeys = shuffleInPlace([...allVideoKeys], rng);
    const valVideoCount = Math.min(allVideoKeys.length - 1, Math.max(1, Math.round(allVideoKeys.length * options.valRatio)));
    const valKeySet = new Set(shuffledKeys.slice(0, valVideoCount));
    train = records.filter((r) => !valKeySet.has(r.videoKey));
    val = records.filter((r) => valKeySet.has(r.videoKey));
  } else {
    train = [...records];
    val = [];
  }

  if (options.shuffle) {
    shuffleInPlace(train, rng);
    if (val.length > 0) shuffleInPlace(val, rng);
  }

  const sourceRunSet = new Set<number>();
  const reasoningRunSet = new Set<number>();
  const profileDistribution: Record<SourceProfile, number> = { standard: 0, short: 0 };
  const turnNoDistribution: Record<number, number> = {};
  const tierDistribution: Record<ThinkTier, number> = { short: 0, medium: 0, long: 0 };
  const materialSet = new Set<number>();

  for (const rec of records) {
    sourceRunSet.add(rec.sourceRunId);
    reasoningRunSet.add(rec.reasoningRunId);
    profileDistribution[rec.sourceProfile]++;
    turnNoDistribution[rec.turnNo] = (turnNoDistribution[rec.turnNo] ?? 0) + 1;
    tierDistribution[rec.lengthTier]++;
    materialSet.add(rec.materialId);
  }

  return {
    train,
    val,
    skippedMissingTurns,
    skippedDialogues,
    includedSourceRunIds: [...sourceRunSet].sort((a, b) => a - b),
    includedReasoningRunIds: [...reasoningRunSet].sort((a, b) => a - b),
    profileDistribution,
    turnNoDistribution,
    tierDistribution,
    materialCount: materialSet.size,
    trainVideoCount: new Set(train.map((r) => r.videoKey)).size,
    valVideoCount: new Set(val.map((r) => r.videoKey)).size,
    expandTurns,
    format,
  };
}

interface ParsedChecksJson {
  finalMetrics?: RuleCheckMetrics | null;
  llmReview?: { decision?: string; issues?: string[]; feedback?: string } | null;
  attempts?: Array<{
    attemptNo: number;
    rulePassed: boolean;
    ruleIssues: string[];
    llmDecision: string | null;
    llmIssues: string[];
    feedback: string;
  }>;
}

function safeParseChecks(raw: string | null): ParsedChecksJson {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ParsedChecksJson;
  } catch {
    return {};
  }
}

export function computeStatsFromTraces(records: TraceWithContext[]): ReasoningBatchStats {
  const inputs: TraceStatInput[] = records.map((item) => {
    const parsed = safeParseChecks(item.trace.checks_json);
    return {
      status: item.trace.status,
      decision: item.trace.decision,
      lengthTier: item.trace.length_tier,
      reasoning: item.trace.reasoning,
      metrics: parsed.finalMetrics ?? null,
      rewriteCount: item.trace.rewrite_count,
    };
  });
  return computeBatchStats(inputs);
}

function asBlockquote(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * Formats a human-readable Markdown pilot review sheet displaying batch health metrics,
 * opening-prefix diversity diagnostics, all passed CoT traces side-by-side with golden answers,
 * and dropped/errored diagnostics for rapid Prompt/Skill iteration.
 */
export function formatReviewMarkdown(
  run: ReasoningRunRecord,
  records: TraceWithContext[],
  stats = computeStatsFromTraces(records),
): string {
  const lines: string[] = [];
  lines.push(`# CoT 脱稿补写审阅稿（Reasoning Run #${run.id}）`);
  lines.push("");
  lines.push(`- **状态**：\`${run.status}\` | **Writer**：\`${run.writer_model}\` | **Judge**：\`${run.judge_model ?? "规则层 only"}\``);
  lines.push(`- **开始时间**：${run.started_at}${run.finished_at ? ` | **完成时间**：${run.finished_at}` : ""}`);
  lines.push(`- **通过率**：${stats.passed} / ${stats.total}（**${(stats.passRate * 100).toFixed(1)}%**），丢弃 ${stats.dropped}，错误 ${stats.errored}`);
  lines.push(`- **泄漏词命中样本数**：${stats.totalLeakHitTraces} | **平均重写次数**：${stats.avgRewrites}`);
  lines.push(`- **已通过 \`<think>\` 统计**：均值 ${stats.avgChars} 字 / P50 ${stats.p50Chars} 字 / P90 ${stats.p90Chars} 字 | 均长比 ${(stats.avgLengthRatio * 100).toFixed(1)}%`);
  lines.push(`- **起手多样性（前 8 字）**：${stats.openingDiversity.uniquePrefixCount} / ${stats.openingDiversity.evaluatedCount} 唯一（${(stats.openingDiversity.uniqueRatio * 100).toFixed(1)}%）| 前 2 字最高占比 **${(stats.openingDiversity.max2CharShare * 100).toFixed(1)}%**`);
  if (stats.openingDiversity.topRepeated2Char.length > 0) {
    const repeated2 = stats.openingDiversity.topRepeated2Char.map((r) => `\`${r.prefix}…\` ×${r.count}`).join("、");
    lines.push(`- **高频前 2 字起手**：${repeated2}`);
  }
  if (stats.openingDiversity.topRepeated.length > 0) {
    const repeated = stats.openingDiversity.topRepeated.map((r) => `\`${r.prefix}…\` ×${r.count}`).join("、");
    lines.push(`- **重复前 8 字起手提示**：${repeated}`);
  }
  lines.push("");

  lines.push("## 分档统计");
  lines.push("");
  lines.push("| 档位 | 总数 | 通过 | 平均字数 | P50 | P90 |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const tier of ["short", "medium", "long"] as const) {
    const t = stats.byTier[tier];
    lines.push(`| \`${tier}\` | ${t.total} | ${t.passed} | ${t.avgChars} | ${t.p50Chars} | ${t.p90Chars} |`);
  }
  lines.push("");

  const passed = records.filter((r) => r.trace.status === "completed" && r.trace.decision === "pass" && r.trace.reasoning);
  const failed = records.filter((r) => !(r.trace.status === "completed" && r.trace.decision === "pass" && r.trace.reasoning));

  lines.push(`## 已通过样本（${passed.length} 条）`);
  lines.push("");

  for (let i = 0; i < passed.length; i++) {
    const item = passed[i];
    const checks = safeParseChecks(item.trace.checks_json);
    const metrics = checks.finalMetrics;
    const thinkChars = metrics?.charCount ?? countContentChars(item.trace.reasoning ?? "");
    const ansChars = metrics?.answerCharCount ?? countContentChars(item.answer);
    const ratioPct = ((thinkChars / Math.max(1, ansChars)) * 100).toFixed(0);
    const maxRun = metrics ? `${metrics.maxVerbatimRun}字` : "-";

    lines.push(`### #${i + 1} · result=${item.trace.result_id} · turn=${item.trace.turn_no}/${item.turnCount} · \`${item.sourceProfile}\` · \`${item.trace.length_tier}\` · ${item.videoKey}`);
    lines.push("");
    lines.push(`> 指标：\`<think>\` ${thinkChars} 字 / 正文 ${ansChars} 字（${ratioPct}%）· 最长照抄 ${maxRun} · 重写 ${item.trace.rewrite_count} 次`);
    lines.push("");

    if (item.history.length > 0) {
      lines.push("<details>");
      lines.push(`<summary>前序对话历史（${item.history.length / 2} 轮，推理与训练中均不含前轮思考）</summary>`);
      lines.push("");
      for (const h of item.history) {
        lines.push(`**${h.role === "user" ? "问" : "答"}**：${h.content.replace(/\r?\n/g, " ")}`);
        lines.push("");
      }
      lines.push("</details>");
      lines.push("");
    }

    lines.push(`**提问（Turn ${item.trace.turn_no}）**：${item.question}`);
    lines.push("");
    lines.push("**补写 `<think>`**：");
    lines.push("");
    lines.push(asBlockquote(item.trace.reasoning ?? ""));
    lines.push("");
    lines.push("**金标回答**：");
    lines.push("");
    lines.push(item.answer.trim());
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  if (failed.length > 0) {
    lines.push(`## 未通过 / 异常样本（${failed.length} 条）`);
    lines.push("");
    for (const item of failed) {
      const checks = safeParseChecks(item.trace.checks_json);
      const lastAttempt = checks.attempts?.[checks.attempts.length - 1];
      const reason = item.trace.error
        ?? (lastAttempt?.ruleIssues?.length
          ? `规则拦截：${lastAttempt.ruleIssues.join("；")}`
          : lastAttempt?.llmIssues?.length
            ? `质检拦截（${lastAttempt.llmDecision}）：${lastAttempt.llmIssues.join("；")}`
            : "未通过质检");
      lines.push(`- **result=${item.trace.result_id} turn=${item.trace.turn_no} (\`${item.trace.length_tier}\`, ${item.videoKey})** · 状态 \`${item.trace.status}/${item.trace.decision ?? "-"}\` · 重写 ${item.trace.rewrite_count} 次 · 原因：${reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function buildExportManifest(input: {
  dbPath: string;
  outPath: string;
  trainJsonl: string;
  valOutPath?: string;
  valJsonl?: string;
  reasoningRunId?: number;
  hasSystemPrompt: boolean;
  shuffled: boolean;
  seed?: number;
  result: ReasoningExportResult;
}): Record<string, unknown> {
  return {
    exportedAt: new Date().toISOString(),
    db: input.dbPath,
    ...(input.reasoningRunId !== undefined ? { reasoningRunId: input.reasoningRunId } : { reasoningRunId: "latest-any" }),
    format: input.result.format,
    expandTurns: input.result.expandTurns,
    recommendedMsSwiftArgs: input.result.format === "inline"
      ? [
          "--model_type",
          "qwen3_5",
          "--template",
          "qwen3_8",
          "--use_chat_template",
          "true",
          "--enable_thinking",
          "true",
          "--loss_scale",
          input.result.expandTurns ? "last_round" : "default",
        ]
      : [],
    ...(input.result.format !== "inline"
      ? {
          msSwiftWarning:
            "ms-swift 4.6.0 会静默丢弃 reasoning_content 字段并编码为空思考块；用于 ms-swift 训练请改用 --format inline（reasoning_content 仅适用于直调 HF apply_chat_template）",
        }
      : {}),
    includedSourceRunIds: input.result.includedSourceRunIds,
    includedReasoningRunIds: input.result.includedReasoningRunIds,
    profileDistribution: input.result.profileDistribution,
    turnNoDistribution: input.result.turnNoDistribution,
    tierDistribution: input.result.tierDistribution,
    skippedMissingTurns: input.result.skippedMissingTurns,
    skippedDialogues: input.result.skippedDialogues,
    materialCount: input.result.materialCount,
    trainVideoCount: input.result.trainVideoCount,
    valVideoCount: input.result.valVideoCount,
    trainSamples: input.result.train.length,
    valSamples: input.result.val.length,
    hasSystemPrompt: input.hasSystemPrompt,
    shuffled: input.shuffled,
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    out: input.outPath,
    outSha256: sha256Hex(input.trainJsonl),
    ...(input.valOutPath && input.valJsonl !== undefined
      ? { valOut: input.valOutPath, valSha256: sha256Hex(input.valJsonl) }
      : {}),
  };
}
