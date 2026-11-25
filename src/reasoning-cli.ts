import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { validateMaxTurns, type DedupPolicy } from "./db.js";
import {
  DEFAULT_REASONING_CHECK_CONFIG,
  parseProfileFilter,
  parseTierFilter,
  type ProfileFilter,
  type ReasoningCheckConfig,
  type ThinkTier,
} from "./reasoning-checks.js";
import {
  createReasoningRunners,
  DEFAULT_REASONING_JUDGE_SKILL,
  DEFAULT_REASONING_PROMPTS_DIR,
  DEFAULT_REASONING_WRITER_SKILL,
  readReasoningJudgeSkill,
  readReasoningPiConfigs,
  readReasoningPrompts,
  readReasoningWriterSkill,
  runReasoningBackfill,
  selectStratifiedTurns,
} from "./reasoning-engine.js";
import {
  buildExportManifest,
  buildReasoningExportDataset,
  formatReasoningJsonl,
  formatReviewMarkdown,
  type ReasoningExportFormat,
} from "./reasoning-export.js";
import { ReasoningStore } from "./reasoning-store.js";
import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "./retry.js";
import { errorMessage, nonEmpty, validateConcurrency, validateSplit } from "./schema.js";
import type { DatasetSplit } from "./types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function parsePositiveInt(raw: string, label: string): number {
  const value = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} 必须是正整数`);
  }
  return value;
}

function parseNonNegativeInt(raw: string, label: string): number {
  const value = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负整数`);
  }
  return value;
}

function parseRunIdList(raw: string, label: string): number[] {
  const ids = raw.split(",").map((part) => parsePositiveInt(part, label));
  return [...new Set(ids)];
}

function parseUnitFloat(raw: string, label: string): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${label} 必须是 (0, 1] 之间的小数`);
  }
  return value;
}

const HELP = `脱稿逆向补写 CoT（<think>）并导出 ms-swift 训练 JSONL 与人工审阅稿

查看待补写轮次分布与历史补写运行（只读，不调用模型）：
  npm run reasoning -- --status

30 轮分层试点（按 short/medium/long × 轮次均衡抽样 + 生成审阅稿与试点 JSONL）：
  npm run reasoning -- --limit 30 --stratified --seed 42 --review-md output/cot-pilot-review.md --export output/cot-pilot.jsonl --manifest output/cot-pilot-manifest.json

全量增量补写（自动跳过已通过质检的轮次）：
  npm run reasoning -- --only-missing --concurrency 10 --export output/train-cot.jsonl --manifest output/train-cot-manifest.json

从已有补写运行离线导出（不调用模型，默认 inline 格式适配 ms-swift 4.6.0）：
  npm run reasoning -- --export-only --reasoning-run 2 --format inline --expand-turns --export output/train-cot.jsonl --review-md output/cot-review.md

环境变量（支持独立指定补写模型，未设置时自动回退到 .env 的 LLM_*）：
  REASONING_BASE_URL / REASONING_MODEL / REASONING_API_KEY / REASONING_THINKING_LEVEL
  REASONING_JUDGE_BASE_URL / REASONING_JUDGE_MODEL / REASONING_JUDGE_API_KEY / REASONING_JUDGE_THINKING_LEVEL

参数：
  --status                       仅查看库内可补写轮次与历史 reasoning_runs 状态
  --export-only                  离线导出模式（搭配 --reasoning-run ID 或最新全部通过记录）
  --reasoning-run ID             导出/审阅指定的 reasoning_run_id（默认取本次或全库最新通过）
  --db PATH                      统一 SQLite 路径，默认 data/data-maker.sqlite
  --runs ID1,ID2,...             仅针对指定 answer_judge run_id 补写/导出（默认全库正式训练运行）
  --exclude-runs IDs             排除指定 answer_judge run_id
  --split SPLIT                  分区过滤：train | test | dpo（全库正式默认过滤 train）
  --profile MODE                 来源风格过滤：all（默认，同时包含 standard 与 short）| standard | short
  --tier TIERS                   档位过滤：short | medium | long（支持逗号分隔，如 --tier long）
  --dedup POLICY                 同题多版本选版策略：latest（默认）| earliest | error
  --min-turns N                  仅处理对话轮数 >= N 的样本
  --max-turns N                  仅处理对话轮数 <= N 的样本
  --only-missing                 增量跳过已有 pass 补写记录的轮次
  --limit N                      限制本次补写轮数（如试点 30）
  --stratified                   搭配 --limit 使用：按 (来源风格 × 档位 × 轮次) 分层并跨视频分散抽样
  --seed N                       固定随机种子（用于 --stratified / --shuffle / --val-ratio）
  --concurrency N                并发数 1–500（默认 10）
  --max-rewrites N               单轮规则/质检不通过时最大重写次数 0–5（默认 3）
  --no-llm-judge                 跳过 LLM 一致性审查，仅执行确定性规则拦截
  --call-attempts N              单次模型调用最大尝试次数 1–10（默认 3）
  --retry-delay-ms N             单次模型调用失败重试间隔毫秒 0–60000（默认 3000）
  --writer-thinking LEVEL        覆盖补写模型思考强度（off|low|medium|high|max）
  --judge-thinking LEVEL         覆盖评审模型思考强度（off|low|medium|high|max）
  --max-chars N                  思考异常过长安全上限字数（默认 800）
  --max-verbatim N               连续极端照抄安全上限字数（默认 36）
  --writer-skill PATH            自定义 reasoning-writer Skill 路径
  --judge-skill PATH             自定义 reasoning-judge Skill 路径
  --prompts DIR                  自定义提示词目录（默认 prompts）
  --review-md PATH               输出人工审阅 Markdown 文件路径
  --export PATH                  输出 ms-swift CoT 训练 JSONL 路径
  --val-out PATH                 可选：按视频整块切分验证集 JSONL 路径（需搭配 --val-ratio）
  --val-ratio FLOAT              可选：验证集视频比例 (0, 1)
  --manifest PATH                可选：导出溯源清单 JSON 路径
  --format FORMAT                CoT 字段格式：inline（默认，<think>内联，ms-swift 4.6.0 必选）| reasoning_content（直调 HF apply_chat_template）
  --expand-turns                 按对话轮展开（默认开启；历史轮纯正文，仅末轮带 CoT，配 ms-swift --loss_scale last_round）
  --no-expand-turns              关闭按轮展开（单条包含全轮次 CoT，配 --loss_scale default，适合推理侧保留历史思考）
  --shuffle                      导出时打乱样本顺序
  --system TEXT                  可选：每条导出样本前置 system 消息
  --system-file PATH             可选：从文件读取前置 system 消息（与 --system 互斥）
  --help                         查看说明
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      status: { type: "boolean", default: false },
      "export-only": { type: "boolean", default: false },
      "reasoning-run": { type: "string" },
      runs: { type: "string" },
      "exclude-runs": { type: "string" },
      split: { type: "string" },
      profile: { type: "string" },
      tier: { type: "string" },
      dedup: { type: "string" },
      "min-turns": { type: "string" },
      "max-turns": { type: "string" },
      "only-missing": { type: "boolean", default: false },
      limit: { type: "string" },
      stratified: { type: "boolean", default: false },
      seed: { type: "string" },
      concurrency: { type: "string" },
      "max-rewrites": { type: "string" },
      "no-llm-judge": { type: "boolean", default: false },
      "call-attempts": { type: "string" },
      "retry-delay-ms": { type: "string" },
      "writer-thinking": { type: "string" },
      "judge-thinking": { type: "string" },
      "max-chars": { type: "string" },
      "max-verbatim": { type: "string" },
      "writer-skill": { type: "string" },
      "judge-skill": { type: "string" },
      prompts: { type: "string" },
      "review-md": { type: "string" },
      export: { type: "string" },
      "val-out": { type: "string" },
      "val-ratio": { type: "string" },
      manifest: { type: "string" },
      format: { type: "string" },
      "expand-turns": { type: "boolean", default: false },
      "no-expand-turns": { type: "boolean", default: false },
      shuffle: { type: "boolean", default: false },
      system: { type: "string" },
      "system-file": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  if (values.status && values["export-only"]) {
    throw new Error("--status 与 --export-only 不能同时指定");
  }
  if (values["expand-turns"] && values["no-expand-turns"]) {
    throw new Error("--expand-turns 与 --no-expand-turns 不能同时指定");
  }
  if (values.system !== undefined && values["system-file"] !== undefined) {
    throw new Error("--system 与 --system-file 不能同时指定");
  }
  if ((values["val-out"] !== undefined) !== (values["val-ratio"] !== undefined)) {
    throw new Error("--val-out 与 --val-ratio 必须成对指定");
  }
  if (values["val-out"] !== undefined && values.export === undefined) {
    throw new Error("--val-out 必须搭配 --export 使用");
  }

  const dbPath = resolve(values.db ?? join(ROOT, "data/data-maker.sqlite"));
  const runIds = values.runs !== undefined ? parseRunIdList(values.runs, "--runs") : undefined;
  const excludeRunIds = values["exclude-runs"] !== undefined ? parseRunIdList(values["exclude-runs"], "--exclude-runs") : undefined;
  const split: DatasetSplit | undefined = values.split !== undefined ? validateSplit(values.split, "--split") : undefined;
  const profile: ProfileFilter = parseProfileFilter(values.profile, "--profile");
  const tiers: ThinkTier[] | undefined = parseTierFilter(values.tier, "--tier");
  const dedup = (values.dedup ?? "latest") as DedupPolicy;
  if (dedup !== "latest" && dedup !== "earliest" && dedup !== "error") {
    throw new Error("--dedup 必须为 latest、earliest 或 error");
  }
  const minTurns = values["min-turns"] !== undefined ? validateMaxTurns(Number(values["min-turns"])) : undefined;
  const maxTurns = values["max-turns"] !== undefined ? validateMaxTurns(Number(values["max-turns"])) : undefined;
  const seed = values.seed !== undefined ? Number(values.seed) : undefined;
  if (seed !== undefined && !Number.isSafeInteger(seed)) {
    throw new Error("--seed 必须是整数");
  }
  const format = (values.format ?? "inline") as ReasoningExportFormat;
  if (format !== "reasoning_content" && format !== "inline") {
    throw new Error("--format 必须为 reasoning_content 或 inline");
  }
  const expandTurns = values["no-expand-turns"] ? false : true;
  const valRatio = values["val-ratio"] !== undefined ? Number(values["val-ratio"]) : undefined;

  let systemPrompt: string | undefined;
  if (values.system !== undefined) {
    systemPrompt = nonEmpty(values.system, "--system");
  } else if (values["system-file"] !== undefined) {
    systemPrompt = nonEmpty(await readFile(resolve(values["system-file"]), "utf8"), "--system-file");
  }

  const queryOptions = {
    allFormal: runIds === undefined,
    runIds,
    excludeRunIds,
    split,
    profile,
    tiers,
    dedup,
    minTurns,
    maxTurns,
  };

  // Mode 1: --status (strictly read-only, zero model calls)
  if (values.status) {
    const store = new ReasoningStore(dbPath, { readOnly: true });
    try {
      const summary = store.getStatusSummary(queryOptions);
      console.log(JSON.stringify({ db: dbPath, ...summary }, null, 2));
      return;
    } finally {
      store.close();
    }
  }

  // Mode 2: --export-only (strictly read-only, zero model calls)
  if (values["export-only"]) {
    if (values.export === undefined && values["review-md"] === undefined) {
      throw new Error("--export-only 模式至少需要指定 --export 或 --review-md");
    }
    const store = new ReasoningStore(dbPath, { readOnly: true });
    try {
      const explicitReasoningRunId = values["reasoning-run"] !== undefined
        ? parsePositiveInt(values["reasoning-run"], "--reasoning-run")
        : undefined;

      const outputReport: Record<string, unknown> = { db: dbPath, mode: "export-only" };

      if (values["review-md"] !== undefined) {
        const targetRunId = explicitReasoningRunId ?? store.getLatestReasoningRunId();
        if (targetRunId === undefined) {
          throw new Error("库中尚无 reasoning_runs 记录，无法生成审阅稿");
        }
        const run = store.getReasoningRun(targetRunId);
        if (!run) throw new Error(`未找到 reasoning_run_id=${targetRunId}`);
        const traces = store.queryRunTracesWithContext(targetRunId);
        const reviewMd = formatReviewMarkdown(run, traces);
        const reviewPath = resolve(nonEmpty(values["review-md"], "--review-md"));
        await mkdir(dirname(reviewPath), { recursive: true });
        await writeFile(reviewPath, reviewMd, "utf8");
        outputReport.reviewMd = reviewPath;
        outputReport.reviewRunId = targetRunId;
        outputReport.reviewTraceCount = traces.length;
      }

      if (values.export !== undefined) {
        const exportResult = buildReasoningExportDataset(store, {
          ...queryOptions,
          reasoningRunId: explicitReasoningRunId,
          expandTurns,
          format,
          systemPrompt,
          shuffle: Boolean(values.shuffle),
          seed,
          valRatio,
        });
        const outPath = resolve(nonEmpty(values.export, "--export"));
        const trainJsonl = formatReasoningJsonl(exportResult.train.map((r) => r.sample));
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, trainJsonl, "utf8");

        let valOutPath: string | undefined;
        let valJsonl: string | undefined;
        if (values["val-out"] !== undefined) {
          valOutPath = resolve(nonEmpty(values["val-out"], "--val-out"));
          valJsonl = formatReasoningJsonl(exportResult.val.map((r) => r.sample));
          await mkdir(dirname(valOutPath), { recursive: true });
          await writeFile(valOutPath, valJsonl, "utf8");
        }

        const manifest = buildExportManifest({
          dbPath,
          outPath,
          trainJsonl,
          valOutPath,
          valJsonl,
          reasoningRunId: explicitReasoningRunId,
          hasSystemPrompt: systemPrompt !== undefined,
          shuffled: Boolean(values.shuffle),
          seed,
          result: exportResult,
        });
        if (values.manifest !== undefined) {
          const manifestPath = resolve(nonEmpty(values.manifest, "--manifest"));
          await mkdir(dirname(manifestPath), { recursive: true });
          await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
        }
        outputReport.export = manifest;
      }

      console.log(JSON.stringify(outputReport, null, 2));
      return;
    } finally {
      store.close();
    }
  }

  // Mode 3: Backfill CoT (+ optional review-md & export)
  const checkConfig: ReasoningCheckConfig = {
    maxChars: values["max-chars"] !== undefined
      ? parsePositiveInt(values["max-chars"], "--max-chars")
      : DEFAULT_REASONING_CHECK_CONFIG.maxChars,
    maxVerbatimRun: values["max-verbatim"] !== undefined
      ? parsePositiveInt(values["max-verbatim"], "--max-verbatim")
      : DEFAULT_REASONING_CHECK_CONFIG.maxVerbatimRun,
  };

  const concurrency = values.concurrency !== undefined ? validateConcurrency(Number(values.concurrency)) : 10;
  const maxRewrites = values["max-rewrites"] !== undefined ? parseNonNegativeInt(values["max-rewrites"], "--max-rewrites") : 3;
  const callMaxAttempts = values["call-attempts"] !== undefined
    ? validateCallMaxAttempts(Number(values["call-attempts"]))
    : DEFAULT_CALL_MAX_ATTEMPTS;
  const callRetryDelayMs = values["retry-delay-ms"] !== undefined
    ? validateCallRetryDelayMs(Number(values["retry-delay-ms"]))
    : DEFAULT_CALL_RETRY_DELAY_MS;
  const limit = values.limit !== undefined ? parsePositiveInt(values.limit, "--limit") : undefined;

  const writerSkillPath = resolve(values["writer-skill"] ?? DEFAULT_REASONING_WRITER_SKILL);
  const judgeSkillPath = resolve(values["judge-skill"] ?? DEFAULT_REASONING_JUDGE_SKILL);
  const promptsDir = resolve(values.prompts ?? DEFAULT_REASONING_PROMPTS_DIR);
  const useLlmJudge = !values["no-llm-judge"];

  const [writerSkill, judgeSkill, prompts] = await Promise.all([
    readReasoningWriterSkill(writerSkillPath),
    useLlmJudge ? readReasoningJudgeSkill(judgeSkillPath) : Promise.resolve(undefined),
    readReasoningPrompts(promptsDir),
  ]);

  const piConfigs = readReasoningPiConfigs({
    ...process.env,
    ...(values["writer-thinking"] !== undefined ? { REASONING_THINKING_LEVEL: values["writer-thinking"] } : {}),
    ...(values["judge-thinking"] !== undefined ? { REASONING_JUDGE_THINKING_LEVEL: values["judge-thinking"] } : {}),
  });
  const runners = createReasoningRunners(piConfigs);

  const store = new ReasoningStore(dbPath);
  try {
    const recovered = store.recoverInterruptedRuns();
    const allCandidates = store.queryCandidateTurns({
      ...queryOptions,
      onlyMissing: Boolean(values["only-missing"]),
    });

    const selectedCandidates = limit !== undefined
      ? (values.stratified
          ? selectStratifiedTurns(allCandidates, limit, seed ?? 42)
          : allCandidates.slice(0, limit))
      : allCandidates;

    if (selectedCandidates.length === 0) {
      console.log(
        JSON.stringify(
          {
            db: dbPath,
            recovered,
            selectedTurns: 0,
            message: "没有待补写的通过对话轮次",
          },
          null,
          2,
        ),
      );
      return;
    }

    const backfill = await runReasoningBackfill({
      store,
      candidates: selectedCandidates,
      writerPrompt: prompts.writer,
      writerSkill,
      writerSkillPath,
      judgePrompt: useLlmJudge ? prompts.judge : undefined,
      judgeSkill,
      judgeSkillPath: useLlmJudge ? judgeSkillPath : undefined,
      runWriter: runners.runWriter,
      runJudge: useLlmJudge ? runners.runJudge : undefined,
      writerModel: piConfigs.writer.modelId,
      judgeModel: useLlmJudge ? piConfigs.judge.modelId : null,
      checkConfig,
      maxRewrites,
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
      configSnapshot: {
        writerBaseUrl: piConfigs.writer.baseUrl,
        writerThinkingLevel: piConfigs.writer.thinkingLevel,
        ...(useLlmJudge
          ? { judgeBaseUrl: piConfigs.judge.baseUrl, judgeThinkingLevel: piConfigs.judge.thinkingLevel }
          : {}),
        stratified: Boolean(values.stratified),
        onlyMissing: Boolean(values["only-missing"]),
        profile,
        ...(tiers ? { tiers } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(seed !== undefined ? { seed } : {}),
      },
      onProgress: ({ completed, total, turn, decision }) => {
        process.stderr.write(
          `[reasoning ${completed}/${total}] result=${turn.resultId} turn=${turn.turnNo}/${turn.turnCount} profile=${turn.sourceProfile} tier=${turn.lengthTier} -> ${decision}\n`,
        );
      },
    });

    const summary: Record<string, unknown> = {
      db: dbPath,
      recovered,
      reasoningRunId: backfill.reasoningRunId,
      writerModel: piConfigs.writer.modelId,
      judgeModel: useLlmJudge ? piConfigs.judge.modelId : null,
      selectedTurns: backfill.selectedTurns,
      stats: backfill.stats,
    };

    if (values["review-md"] !== undefined) {
      const runRecord = store.getReasoningRun(backfill.reasoningRunId)!;
      const traces = store.queryRunTracesWithContext(backfill.reasoningRunId);
      const reviewMd = formatReviewMarkdown(runRecord, traces, backfill.stats);
      const reviewPath = resolve(nonEmpty(values["review-md"], "--review-md"));
      await mkdir(dirname(reviewPath), { recursive: true });
      await writeFile(reviewPath, reviewMd, "utf8");
      summary.reviewMd = reviewPath;
    }

    if (values.export !== undefined) {
      const exportReasoningRunId = values["only-missing"] ? undefined : backfill.reasoningRunId;
      const exportResult = buildReasoningExportDataset(store, {
        ...queryOptions,
        reasoningRunId: exportReasoningRunId,
        expandTurns,
        format,
        systemPrompt,
        shuffle: Boolean(values.shuffle),
        seed,
        valRatio,
      });
      const outPath = resolve(nonEmpty(values.export, "--export"));
      const trainJsonl = formatReasoningJsonl(exportResult.train.map((r) => r.sample));
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, trainJsonl, "utf8");

      let valOutPath: string | undefined;
      let valJsonl: string | undefined;
      if (values["val-out"] !== undefined) {
        valOutPath = resolve(nonEmpty(values["val-out"], "--val-out"));
        valJsonl = formatReasoningJsonl(exportResult.val.map((r) => r.sample));
        await mkdir(dirname(valOutPath), { recursive: true });
        await writeFile(valOutPath, valJsonl, "utf8");
      }

      const manifest = buildExportManifest({
        dbPath,
        outPath,
        trainJsonl,
        valOutPath,
        valJsonl,
        reasoningRunId: exportReasoningRunId,
        hasSystemPrompt: systemPrompt !== undefined,
        shuffled: Boolean(values.shuffle),
        seed,
        result: exportResult,
      });
      if (values.manifest !== undefined) {
        const manifestPath = resolve(nonEmpty(values.manifest, "--manifest"));
        await mkdir(dirname(manifestPath), { recursive: true });
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      }
      summary.export = manifest;
    }

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(`错误：${errorMessage(error)}`);
  process.exitCode = 1;
});
