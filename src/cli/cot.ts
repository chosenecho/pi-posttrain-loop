import { parseArgs } from "node:util";
import {
  parseFloatOpt,
  parseIdList,
  parseIntOpt,
  parseNonNegativeInt,
  parsePositiveInt,
  readSystemPromptOption,
} from "../shared/cli-helpers.js";
import { nonEmpty, validateSplit } from "../shared/schema.js";
import type { DedupPolicy } from "../shared/types.js";
import { ALL_SYNTH_PROFILES } from "../shared/types.js";
import { parseProfileFilter, parseTierFilter } from "../reasoning/checks.js";
import type { ReasoningExportFormat } from "../reasoning/export.js";
import {
  COT_BACKFILL_PRESETS,
  COT_EXPORT_PRESETS,
  resolveCotBackfillPreset,
  resolveCotExportPreset,
} from "../reasoning/presets.js";
import {
  getReasoningStatus,
  runReasoningBackfillWorkflow,
  runReasoningExportWorkflow,
} from "../reasoning/workflows.js";

const COT_HELP = `脱稿思考链（CoT）逆向补写与导出命令组（npm run dm -- cot <子命令>）

子命令：
  status     查看各档位与轮次的 CoT 覆盖率与待补写数量
  backfill   脱稿逆向补写思考链并执行 LLM 盲审质检
  review     生成人工抽检 Markdown 审阅稿
  export     导出 CoT 训练集 JSONL（inline / reasoning_content）

常用示例：
  npm run dm -- cot status
  npm run dm -- cot backfill --preset pilot --review-md output/cot-pilot-review.md
  npm run dm -- cot backfill --preset full --concurrency 10
  npm run dm -- cot review --out output/cot-review.md
  npm run dm -- cot export --preset train-cot-val --out output/train-cot.jsonl --val-out output/val-cot.jsonl --manifest output/cot-manifest.json

使用 npm run dm -- cot <子命令> --help 查看具体参数。
`;

const BACKFILL_HELP = `npm run dm -- cot backfill [选项]

内置预设（--preset，显式参数可覆盖任意字段）：
${Object.values(COT_BACKFILL_PRESETS).map((p) => `  ${p.name.padEnd(10)} ${p.description}`).join("\n")}

选项：
  --preset NAME             内置预设名（pilot | full）
  --limit N                 本次最多补写轮次数
  --stratified              按档位 × 轮次分层抽样（搭配 --limit）
  --seed N                  随机种子（默认 42）
  --only-missing            跳过已有通过思考链的轮次（--preset pilot/full 默认开启）
  --profile FILTER          筛选来源风格：all | ${ALL_SYNTH_PROFILES.join(" | ")}
  --tier LIST               筛选长度档位，逗号分隔：short,medium,long
  --split SPLIT             筛选分区：train | test | dpo
  --runs ID1,ID2            仅筛选指定 answer_judge run_id
  --exclude-runs IDs        排除指定 run_id
  --min-turns N / --max-turns N   按对话轮数过滤
  --dedup POLICY            同题选版策略：latest | earliest | error
  --concurrency N           并发数（默认 10）
  --max-rewrites N          每轮最大返工次数（默认 6，允许 0–10）
  --no-llm-judge            关闭 LLM 盲审裁判（仅跑硬安全阀）
  --writer-thinking LEVEL   覆盖补写器 thinking level
  --judge-thinking LEVEL    覆盖裁判 thinking level
  --max-chars N             硬安全阀最大思考字符数
  --max-verbatim-run N      硬安全阀连续原样照抄上限
  --writer-skill PATH / --judge-skill PATH / --prompts DIR
  --review-md PATH          跑完自动生成人工抽检 Markdown 审阅稿
  --export PATH             跑完自动导出 CoT JSONL
  --val-out PATH / --val-ratio FLOAT / --manifest PATH
  --format FORMAT           导出格式：inline（默认）| reasoning_content
  --no-expand-turns         不按轮展开（保持单条完整多轮）
  --shuffle                 导出时打乱样本顺序
  --system TEXT / --system-file PATH
  --db PATH                 主库路径（默认 data/data-maker.sqlite）
  --call-attempts N / --retry-delay-ms N
`;

const EXPORT_HELP = `npm run dm -- cot export [选项]

内置预设（--preset，显式参数可覆盖任意字段）：
${Object.values(COT_EXPORT_PRESETS).map((p) => `  ${p.name.padEnd(16)} ${p.description}`).join("\n")}

选项：
  --preset NAME             内置预设名（train-cot | train-cot-val）
  --out PATH                必填：输出 JSONL 路径
  --val-out PATH            验证集 JSONL 路径（搭配 --val-ratio，或使用 --preset train-cot-val）
  --val-ratio FLOAT         验证集按视频切分比例，如 0.1
  --manifest PATH           审计清单 JSON 路径
  --review-md PATH          可选：同步生成审阅稿 Markdown
  --reasoning-run ID        仅导出指定 reasoning_run_id
  --format FORMAT           导出格式：inline（默认）| reasoning_content
  --no-expand-turns         关闭按轮展开（默认按轮展开以兼容 ms-swift）
  --split SPLIT             筛选分区：train | test | dpo
  --profile FILTER          筛选来源风格：all | ${ALL_SYNTH_PROFILES.join(" | ")}
  --tier LIST               筛选长度档位：short,medium,long
  --runs ID1,ID2 / --exclude-runs IDs / --min-turns N / --max-turns N / --dedup POLICY
  --shuffle / --seed N      打乱顺序与随机种子
  --system TEXT / --system-file PATH
  --no-generalize-tools     关闭工具 Schema 随机泛化（固定为 web_search(query)）
  --negative-tools-ratio F  按比例（0–1）为非搜索样本挂上通用 tools 声明但不调工具
  --db PATH                 主库路径（默认 data/data-maker.sqlite）
`;

function parseDedupPolicy(raw: string | undefined): DedupPolicy | undefined {
  if (raw === undefined) return undefined;
  const policy = raw.trim() as DedupPolicy;
  if (policy !== "latest" && policy !== "earliest" && policy !== "error") {
    throw new Error("--dedup 必须为 latest、earliest 或 error");
  }
  return policy;
}

function parseExportFormat(raw: string | undefined): ReasoningExportFormat | undefined {
  if (raw === undefined) return undefined;
  const fmt = raw.trim() as ReasoningExportFormat;
  if (fmt !== "inline" && fmt !== "reasoning_content") {
    throw new Error("--format 必须为 inline 或 reasoning_content");
  }
  return fmt;
}

export async function runCotCli(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    console.log(COT_HELP);
    return;
  }

  const sub = args[0]!;
  const rest = args.slice(1);

  if (sub === "status") {
    const { values } = parseArgs({
      args: rest,
      options: {
        db: { type: "string" },
        split: { type: "string" },
        profile: { type: "string" },
        tier: { type: "string" },
        runs: { type: "string" },
        "exclude-runs": { type: "string" },
        "min-turns": { type: "string" },
        "max-turns": { type: "string" },
        dedup: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log("用法：npm run dm -- cot status [--db PATH] [--split train|test|dpo] [--profile FILTER] [--tier short,medium,long]");
      return;
    }
    const status = getReasoningStatus({
      dbPath: values.db,
      split: values.split !== undefined ? validateSplit(values.split, "--split") : undefined,
      profile: values.profile !== undefined ? parseProfileFilter(values.profile, "--profile") : undefined,
      tiers: values.tier !== undefined ? parseTierFilter(values.tier, "--tier") : undefined,
      runIds: parseIdList(values.runs, "--runs"),
      excludeRunIds: parseIdList(values["exclude-runs"], "--exclude-runs"),
      minTurns: parsePositiveInt(values["min-turns"], "--min-turns"),
      maxTurns: parsePositiveInt(values["max-turns"], "--max-turns"),
      dedup: parseDedupPolicy(values.dedup),
    });
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (sub === "backfill") {
    const { values } = parseArgs({
      args: rest,
      options: {
        preset: { type: "string" },
        db: { type: "string" },
        split: { type: "string" },
        profile: { type: "string" },
        tier: { type: "string" },
        runs: { type: "string" },
        "exclude-runs": { type: "string" },
        "min-turns": { type: "string" },
        "max-turns": { type: "string" },
        dedup: { type: "string" },
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
        "max-verbatim-run": { type: "string" },
        "writer-skill": { type: "string" },
        "judge-skill": { type: "string" },
        prompts: { type: "string" },
        "review-md": { type: "string" },
        export: { type: "string" },
        "val-out": { type: "string" },
        "val-ratio": { type: "string" },
        manifest: { type: "string" },
        format: { type: "string" },
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
      console.log(BACKFILL_HELP);
      return;
    }

    const preset = resolveCotBackfillPreset(values.preset);
    const systemPrompt = await readSystemPromptOption({
      system: values.system,
      systemFile: values["system-file"],
    });
    const summary = await runReasoningBackfillWorkflow({
      dbPath: values.db,
      split: values.split !== undefined ? validateSplit(values.split, "--split") : undefined,
      profile: values.profile !== undefined ? parseProfileFilter(values.profile, "--profile") : preset?.profile,
      tiers: values.tier !== undefined ? parseTierFilter(values.tier, "--tier") : undefined,
      runIds: parseIdList(values.runs, "--runs"),
      excludeRunIds: parseIdList(values["exclude-runs"], "--exclude-runs"),
      minTurns: parsePositiveInt(values["min-turns"], "--min-turns"),
      maxTurns: parsePositiveInt(values["max-turns"], "--max-turns"),
      dedup: parseDedupPolicy(values.dedup),
      onlyMissing: values["only-missing"] || Boolean(preset?.onlyMissing),
      limit: parsePositiveInt(values.limit, "--limit") ?? preset?.limit,
      stratified: values.stratified || Boolean(preset?.stratified),
      seed: parseIntOpt(values.seed, "--seed") ?? preset?.seed,
      concurrency: parsePositiveInt(values.concurrency, "--concurrency") ?? preset?.concurrency,
      maxRewrites: parseNonNegativeInt(values["max-rewrites"], "--max-rewrites"),
      noLlmJudge: values["no-llm-judge"],
      callMaxAttempts: parsePositiveInt(values["call-attempts"], "--call-attempts"),
      callRetryDelayMs: parseIntOpt(values["retry-delay-ms"], "--retry-delay-ms"),
      writerThinking: values["writer-thinking"],
      judgeThinking: values["judge-thinking"],
      maxChars: parsePositiveInt(values["max-chars"], "--max-chars"),
      maxVerbatimRun: parsePositiveInt(values["max-verbatim-run"], "--max-verbatim-run"),
      writerSkillPath: values["writer-skill"],
      judgeSkillPath: values["judge-skill"],
      promptsDir: values.prompts,
      reviewMdPath: values["review-md"],
      exportOutPath: values.export,
      valOutPath: values["val-out"],
      valRatio: parseFloatOpt(values["val-ratio"], "--val-ratio"),
      manifestPath: values.manifest,
      format: parseExportFormat(values.format),
      expandTurns: !values["no-expand-turns"],
      shuffle: values.shuffle,
      systemPrompt,
      onProgress: (line) => process.stderr.write(line),
    });
    console.log(JSON.stringify({ ...(preset ? { preset: preset.name } : {}), ...summary }, null, 2));
    return;
  }

  if (sub === "review") {
    const { values } = parseArgs({
      args: rest,
      options: {
        db: { type: "string" },
        "reasoning-run": { type: "string" },
        out: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log("用法：npm run dm -- cot review --out output/cot-review.md [--reasoning-run ID] [--db PATH]");
      return;
    }
    const report = await runReasoningExportWorkflow({
      dbPath: values.db,
      reasoningRunId: parsePositiveInt(values["reasoning-run"], "--reasoning-run"),
      reviewMdPath: nonEmpty(values.out, "--out"),
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (sub === "export") {
    const { values } = parseArgs({
      args: rest,
      options: {
        preset: { type: "string" },
        db: { type: "string" },
        "reasoning-run": { type: "string" },
        split: { type: "string" },
        profile: { type: "string" },
        tier: { type: "string" },
        runs: { type: "string" },
        "exclude-runs": { type: "string" },
        "min-turns": { type: "string" },
        "max-turns": { type: "string" },
        dedup: { type: "string" },
        out: { type: "string" },
        "val-out": { type: "string" },
        "val-ratio": { type: "string" },
        manifest: { type: "string" },
        "review-md": { type: "string" },
        format: { type: "string" },
        "no-expand-turns": { type: "boolean", default: false },
        shuffle: { type: "boolean", default: false },
        seed: { type: "string" },
        system: { type: "string" },
        "system-file": { type: "string" },
        "no-generalize-tools": { type: "boolean", default: false },
        "negative-tools-ratio": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log(EXPORT_HELP);
      return;
    }

    const preset = resolveCotExportPreset(values.preset);
    const systemPrompt = await readSystemPromptOption({
      system: values.system,
      systemFile: values["system-file"],
    });
    const valRatio = parseFloatOpt(values["val-ratio"], "--val-ratio")
      ?? (values["val-out"] !== undefined ? preset?.valRatio : undefined);

    const report = await runReasoningExportWorkflow({
      dbPath: values.db,
      reasoningRunId: parsePositiveInt(values["reasoning-run"], "--reasoning-run"),
      split: values.split !== undefined ? validateSplit(values.split, "--split") : preset?.split,
      profile: values.profile !== undefined ? parseProfileFilter(values.profile, "--profile") : undefined,
      tiers: values.tier !== undefined ? parseTierFilter(values.tier, "--tier") : undefined,
      runIds: parseIdList(values.runs, "--runs"),
      excludeRunIds: parseIdList(values["exclude-runs"], "--exclude-runs"),
      minTurns: parsePositiveInt(values["min-turns"], "--min-turns"),
      maxTurns: parsePositiveInt(values["max-turns"], "--max-turns"),
      dedup: parseDedupPolicy(values.dedup),
      outPath: values.out !== undefined ? nonEmpty(values.out, "--out") : undefined,
      valOutPath: values["val-out"],
      valRatio,
      manifestPath: values.manifest,
      reviewMdPath: values["review-md"],
      format: parseExportFormat(values.format) ?? preset?.format,
      expandTurns: values["no-expand-turns"] ? false : (preset?.expandTurns ?? true),
      shuffle: values.shuffle || Boolean(preset?.shuffle),
      seed: parseIntOpt(values.seed, "--seed") ?? preset?.seed,
      systemPrompt,
      generalizeTools: !values["no-generalize-tools"],
      negativeToolsRatio: parseFloatOpt(values["negative-tools-ratio"], "--negative-tools-ratio"),
    });
    console.log(JSON.stringify({ ...(preset ? { preset: preset.name } : {}), ...report }, null, 2));
    return;
  }

  throw new Error(`未知 cot 子命令：${sub}（运行 npm run dm -- cot --help 查看可用命令）`);
}
