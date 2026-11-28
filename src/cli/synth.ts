import { parseArgs } from "node:util";
import {
  parseFloatOpt,
  parseIdList,
  parseIntOpt,
  parsePositiveInt,
  readSystemPromptOption,
} from "../shared/cli-helpers.js";
import { nonEmpty, parseOptionalSynthProfile, validateSplit } from "../shared/schema.js";
import type { DatasetSplit, DedupPolicy, SynthProfile } from "../shared/types.js";
import type { VideoSortMode } from "../synth/corpus.js";
import { runDemo } from "../synth/demo.js";
import {
  resolveSynthExportPreset,
  resolveSynthRunPreset,
  SYNTH_EXPORT_PRESETS,
  SYNTH_RUN_PRESETS,
  SYNTH_TIER_PROFILES,
} from "../synth/presets.js";
import {
  getSynthStatus,
  runSynthBatchWorkflow,
  runSynthExportWorkflow,
  runSynthJudgeWorkflow,
  runSynthQuestionsWorkflow,
  runSynthSuiteWorkflow,
} from "../synth/workflows.js";

const SYNTH_HELP = `问答与多轮对话合成命令组（npm run dm -- synth <子命令>）

子命令：
  status     查看语料进度、各 profile 覆盖数、分区统计与待质检问题数
  suite      对同一批视频依次跑完 6 套长度/类型 Skill（short / medium / long / xlong / trap / search）
  run        单套 profile 批量生产（出题 -> 多轮问答质检 -> 可选导出）
  questions  仅执行批量或单文件出题入库（支持按 --profile 独立去重）
  judge      仅对题库执行多轮回答与质检（支持增量续跑）
  export     合并导出 JSONL / 切分验证集
  demo       运行 30 秒离线确定性演示（无需 API Key）

常用示例：
  npm run dm -- synth status
  npm run dm -- synth suite --limit 15 --concurrency 10
  npm run dm -- synth run --preset train-short --limit 20
  npm run dm -- synth run --preset train-medium --limit 20
  npm run dm -- synth run --preset train-long --limit 20
  npm run dm -- synth run --preset train-xlong --limit 20
  npm run dm -- synth run --preset train-trap --limit 20
  npm run dm -- synth run --preset train-search --limit 20
  npm run dm -- synth run --preset dpo-pool --limit 15
  npm run dm -- synth judge --only-unjudged --max-turns 3 --concurrency 10
  npm run dm -- synth export --preset train-val --out output/train.jsonl --val-out output/val.jsonl --manifest output/manifest.json
  npm run dm -- synth demo

使用 npm run dm -- synth <子命令> --help 查看具体参数。
注意：test 分区仅供 eval 流水线使用（npm run dm -- eval make），synth 只生产 train / dpo。
`;

const SUITE_HELP = `npm run dm -- synth suite [选项]

对每个未处理视频依次跑完 6 套独立 Skill（short / medium / long / xlong / trap / search），
由各套 Skill 自主控制出题数量、回答篇幅、追问复杂度与检索增强：
  目标参考占比：short ~5% | medium ~20% | long ~25% | xlong ~30% | trap ~10% | search ~10%

常用选项：
  --limit N                 每个 profile 最多抽取未处理视频数量（默认 10）
  --profiles LIST           仅跑指定子集，逗号分隔（默认 short,medium,long,xlong,trap,search）
  --split SPLIT             数据集分区：train（默认）| dpo（test 仅供 eval 流水线）
  --sort MODE               视频排序：core-first（默认）| id（与 --shuffle 互斥）
  --shuffle                 随机打乱待出题视频顺序
  --max-attempts N          每轮返工最大尝试次数（默认 4，含初稿）
  --concurrency N           并发数（默认 10）
  --include-unjudged        同时把库中同 profile 的历史未质检问题并入质检
  --input-dir DIR           语料目录（默认 data/weimingzi-semantic）
  --db PATH                 主库路径（默认 data/data-maker.sqlite）
  --eval-db PATH            独立评测库路径（默认同目录 eval.sqlite）
  --call-attempts N         单次模型调用最大尝试次数（默认 3）
  --retry-delay-ms N        重试间隔毫秒数（默认 1500）
`;

const RUN_HELP = `npm run dm -- synth run [选项]

内置预设（--preset，显式参数可覆盖任意字段）：
${Object.values(SYNTH_RUN_PRESETS).map((p) => `  ${p.name.padEnd(16)} ${p.description}`).join("\n")}

常用选项：
  --preset NAME             内置预设名（推荐）
  --limit N                 本次抽取该 profile 未出题视频数量上限
  --split SPLIT             数据集分区：train（默认）| dpo（test 仅供 eval 流水线）
  --profile PROFILE         风格预设：short | medium | long | xlong | trap | standard（默认）
  --sort MODE               视频排序：id | core-first（与 --shuffle 互斥）
  --shuffle                 随机打乱待出题视频顺序
  --max-questions N         单视频最多生成问题数（安全上限覆盖）
  --max-turns N             多轮对话轮数（short/medium/trap 默认 2，long/xlong/standard 默认 3）
  --max-attempts N          每轮返工最大尝试次数（默认 4，含初稿）
  --concurrency N           并发数（默认 10）
  --include-unjudged        同时把库中该分区同 profile 历史未质检问题并入本批质检
  --export PATH             跑完自动导出本批 JSONL
  --system TEXT / --system-file PATH   导出时注入 system 提示词
  --input-dir DIR           语料目录（默认 data/weimingzi-semantic）
  --db PATH                 主库路径（默认 data/data-maker.sqlite）
  --eval-db PATH            独立评测库路径（用于防泄漏校验，默认同目录 eval.sqlite）
  --no-skill                关闭全部 Skill（仅消融实验）
  --question-skill / --followup-skill / --answer-style / --quality-judge PATH
  --prompts DIR             覆盖提示词目录
  --call-attempts N         单次模型调用最大尝试次数（默认 3）
  --retry-delay-ms N        重试间隔毫秒数（默认 1500）
`;

const QUESTIONS_HELP = `npm run dm -- synth questions [选项]

选项：
  --input FILE              单视频文稿文件路径（与 --input-dir 互斥）
  --input-dir DIR           语料目录（默认 data/weimingzi-semantic）
  --split SPLIT             数据集分区：train（默认）| dpo（test 仅供 eval 流水线）
  --profile PROFILE         风格预设：short | medium | long | xlong | trap | standard（默认）
  --limit N                 本次最多处理该 profile 未出题视频数
  --sort MODE               视频排序：id（默认）| core-first
  --shuffle                 随机抽取待出题视频
  --max-questions N         单视频最多生成问题数（安全上限覆盖）
  --video-id ID             仅 --input 单文件时覆盖 video_id
  --force                   忽略已出题记录强制重新出题
  --concurrency N           并发数（默认 10）
  --question-skill PATH     自定义出题 Skill
  --no-skill                关闭出题 Skill
  --db PATH                 主库路径（默认 data/data-maker.sqlite）
  --call-attempts N         单次调用重试次数（默认 3）
  --retry-delay-ms N        重试间隔毫秒数（默认 1500）
`;

const JUDGE_HELP = `npm run dm -- synth judge [选项]

选项：
  --split SPLIT             按数据集分区过滤：train | dpo（test 仅供 eval 流水线）
  --profile PROFILE         风格预设：short | medium | long | xlong | trap | standard（默认）
  --video-id ID             仅处理指定 video_id 的问题
  --question-ids ID1,ID2    仅处理指定问题 ID 列表
  --only-unjudged           仅增量处理未通过且未完成的题（别名 --resume-unjudged）
  --max-turns N             对话轮数（short/medium/trap 默认 2，long/xlong/standard 默认 3）
  --max-attempts N          每轮最大返工尝试次数（默认 4，含初稿）
  --concurrency N           并发数（默认 10）
  --export PATH             跑完自动导出本批 JSONL
  --system TEXT / --system-file PATH   导出时注入 system 提示词
  --no-skill                关闭全部 Skill
  --prompts DIR             覆盖提示词目录
  --followup-skill / --answer-style / --quality-judge PATH
  --db PATH                 主库路径（默认 data/data-maker.sqlite）
  --call-attempts N         单次调用重试次数（默认 3）
  --retry-delay-ms N        重试间隔毫秒数（默认 1500）
`;

const EXPORT_HELP = `npm run dm -- synth export [选项]

内置预设（--preset，显式参数可覆盖任意字段）：
${Object.values(SYNTH_EXPORT_PRESETS).map((p) => `  ${p.name.padEnd(16)} ${p.description}`).join("\n")}

选项：
  --preset NAME             内置预设名（train-all | train-val）
  --out PATH                必填：输出 JSONL 路径
  --val-out PATH            验证集 JSONL 路径（搭配 --val-ratio，或使用 --preset train-val）
  --val-ratio FLOAT         验证集按视频切分比例，如 0.1
  --manifest PATH           导出审计清单 JSON 路径
  --run ID / --runs ID1,ID2 导出指定单/多个 run_id
  --all-formal              汇总全库指定分区正式样本（未指定 run 时默认开启）
  --split SPLIT             分区过滤：train | dpo（test 仅供 eval 流水线）
  --exclude-runs IDs        排除指定 run_id
  --min-turns N / --max-turns N   按对话轮数过滤
  --dedup POLICY            同题选版策略：latest（默认）| earliest | error
  --shuffle / --seed N      打乱样本顺序与固定随机种子
  --timestamp               为输出文件名自动附加时间戳
  --system TEXT / --system-file PATH   每条样本统一注入 system 消息
  --no-generalize-tools     关闭工具 Schema 随机泛化（固定为 web_search(query)）
  --negative-tools-ratio F  按比例（0–1）为非搜索样本挂上通用 tools 声明但不调工具
  --db PATH                 主库路径（默认 data/data-maker.sqlite）
  --eval-db PATH            独立评测库路径（防泄漏校验）
`;

function parseProfileList(raw: string | undefined): SynthProfile[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error("--profiles 不能为空");
  }
  const result: SynthProfile[] = [];
  for (const item of items) {
    if (item in SYNTH_TIER_PROFILES) {
      const expanded = SYNTH_TIER_PROFILES[item as keyof typeof SYNTH_TIER_PROFILES];
      for (const p of expanded) {
        if (!result.includes(p)) result.push(p);
      }
      continue;
    }
    const profile = parseOptionalSynthProfile(item)!;
    if (!result.includes(profile)) result.push(profile);
  }
  return result;
}

function parseSortMode(raw: string | undefined): VideoSortMode | undefined {
  if (raw === undefined) return undefined;
  const mode = raw.trim() as VideoSortMode;
  if (mode !== "id" && mode !== "core-first") {
    throw new Error("--sort 必须为 id 或 core-first");
  }
  return mode;
}

function parseDedupPolicy(raw: string | undefined): DedupPolicy | undefined {
  if (raw === undefined) return undefined;
  const policy = raw.trim() as DedupPolicy;
  if (policy !== "latest" && policy !== "earliest" && policy !== "error") {
    throw new Error("--dedup 必须为 latest、earliest 或 error");
  }
  return policy;
}

export async function runSynthCli(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    console.log(SYNTH_HELP);
    return;
  }

  const sub = args[0]!;
  const rest = args.slice(1);

  if (sub === "status") {
    const { values } = parseArgs({
      args: rest,
      options: {
        db: { type: "string" },
        "input-dir": { type: "string" },
        split: { type: "string" },
        profile: { type: "string" },
        "max-turns": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log("用法：npm run dm -- synth status [--db PATH] [--input-dir DIR] [--split train|test|dpo] [--profile PROFILE] [--max-turns N]");
      return;
    }
    const report = await getSynthStatus({
      dbPath: values.db,
      inputDir: values["input-dir"],
      split: values.split !== undefined ? validateSplit(values.split, "--split") : undefined,
      profile: parseOptionalSynthProfile(values.profile),
      maxTurns: parsePositiveInt(values["max-turns"], "--max-turns"),
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (sub === "suite") {
    const { values } = parseArgs({
      args: rest,
      options: {
        db: { type: "string" },
        "eval-db": { type: "string" },
        "input-dir": { type: "string" },
        split: { type: "string" },
        profiles: { type: "string" },
        limit: { type: "string" },
        sort: { type: "string" },
        shuffle: { type: "boolean", default: false },
        "max-attempts": { type: "string" },
        concurrency: { type: "string" },
        "call-attempts": { type: "string" },
        "retry-delay-ms": { type: "string" },
        "include-unjudged": { type: "boolean", default: false },
        "no-search": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log(SUITE_HELP);
      return;
    }
    const summary = await runSynthSuiteWorkflow({
      dbPath: values.db,
      evalDbPath: values["eval-db"],
      inputDir: values["input-dir"],
      split: values.split !== undefined ? validateSplit(values.split, "--split") : undefined,
      profiles: parseProfileList(values.profiles),
      limit: parsePositiveInt(values.limit, "--limit"),
      sort: parseSortMode(values.sort),
      shuffle: values.shuffle,
      maxAttempts: parsePositiveInt(values["max-attempts"], "--max-attempts"),
      concurrency: parsePositiveInt(values.concurrency, "--concurrency"),
      callMaxAttempts: parsePositiveInt(values["call-attempts"], "--call-attempts"),
      callRetryDelayMs: parseIntOpt(values["retry-delay-ms"], "--retry-delay-ms"),
      includeUnjudged: values["include-unjudged"],
      ...(values["no-search"] ? { enableSearch: false } : {}),
      onProgress: (msg) => console.error(msg),
    });
    console.log(JSON.stringify(summary, null, 2));
    if (Number(summary.errors ?? 0) > 0 || summary.integrityOk === false) {
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "run") {
    const { values } = parseArgs({
      args: rest,
      options: {
        preset: { type: "string" },
        db: { type: "string" },
        "eval-db": { type: "string" },
        "input-dir": { type: "string" },
        split: { type: "string" },
        profile: { type: "string" },
        limit: { type: "string" },
        sort: { type: "string" },
        shuffle: { type: "boolean", default: false },
        "max-questions": { type: "string" },
        "max-turns": { type: "string" },
        "max-attempts": { type: "string" },
        concurrency: { type: "string" },
        "call-attempts": { type: "string" },
        "retry-delay-ms": { type: "string" },
        "include-unjudged": { type: "boolean", default: false },
        "no-skill": { type: "boolean", default: false },
        prompts: { type: "string" },
        "question-skill": { type: "string" },
        "followup-skill": { type: "string" },
        "answer-style": { type: "string" },
        "quality-judge": { type: "string" },
        export: { type: "string" },
        system: { type: "string" },
        "system-file": { type: "string" },
        "no-search": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log(RUN_HELP);
      return;
    }

    const preset = resolveSynthRunPreset(values.preset);
    const split: DatasetSplit = values.split !== undefined
      ? validateSplit(values.split, "--split")
      : (preset?.split ?? "train");
    const profile: SynthProfile = parseOptionalSynthProfile(values.profile) ?? preset?.profile ?? "standard";
    const sort: VideoSortMode | undefined = parseSortMode(values.sort) ?? (values.shuffle ? undefined : preset?.sort);
    const shuffle = values.shuffle || (values.sort === undefined && Boolean(preset?.shuffle));
    const maxTurns = parsePositiveInt(values["max-turns"], "--max-turns") ?? preset?.maxTurns;
    const maxQuestionsPerVideo = parsePositiveInt(values["max-questions"], "--max-questions") ?? preset?.maxQuestionsPerVideo;
    const exportSystemPrompt = await readSystemPromptOption({
      system: values.system,
      systemFile: values["system-file"],
    });

    const summary = await runSynthBatchWorkflow({
      dbPath: values.db,
      evalDbPath: values["eval-db"],
      inputDir: values["input-dir"],
      split,
      profile,
      limit: parsePositiveInt(values.limit, "--limit"),
      sort,
      shuffle,
      maxQuestionsPerVideo,
      maxTurns,
      maxAttempts: parsePositiveInt(values["max-attempts"], "--max-attempts"),
      concurrency: parsePositiveInt(values.concurrency, "--concurrency"),
      callMaxAttempts: parsePositiveInt(values["call-attempts"], "--call-attempts"),
      callRetryDelayMs: parseIntOpt(values["retry-delay-ms"], "--retry-delay-ms"),
      includeUnjudged: values["include-unjudged"],
      noSkill: values["no-skill"],
      promptsDir: values.prompts,
      skillOverrides: {
        questionSkill: values["question-skill"],
        followupSkill: values["followup-skill"],
        answerStyle: values["answer-style"],
        qualityJudge: values["quality-judge"],
      },
      exportPath: values.export,
      exportSystemPrompt,
      ...(values["no-search"] ? { enableSearch: false } : {}),
      onProgress: (msg) => console.error(msg),
    });
    console.log(JSON.stringify({ ...(preset ? { preset: preset.name } : {}), ...summary }, null, 2));
    if (Number(summary.errors ?? 0) > 0 || summary.integrityOk === false) {
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "questions") {
    const { values } = parseArgs({
      args: rest,
      options: {
        db: { type: "string" },
        input: { type: "string" },
        "input-dir": { type: "string" },
        split: { type: "string" },
        profile: { type: "string" },
        limit: { type: "string" },
        sort: { type: "string" },
        shuffle: { type: "boolean", default: false },
        "max-questions": { type: "string" },
        concurrency: { type: "string" },
        "call-attempts": { type: "string" },
        "retry-delay-ms": { type: "string" },
        force: { type: "boolean", default: false },
        "video-id": { type: "string" },
        "question-skill": { type: "string" },
        "no-skill": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log(QUESTIONS_HELP);
      return;
    }
    const summary = await runSynthQuestionsWorkflow({
      dbPath: values.db,
      input: values.input,
      inputDir: values["input-dir"],
      split: values.split !== undefined ? validateSplit(values.split, "--split") : undefined,
      profile: parseOptionalSynthProfile(values.profile),
      limit: parsePositiveInt(values.limit, "--limit"),
      sort: parseSortMode(values.sort),
      shuffle: values.shuffle,
      maxQuestionsPerVideo: parsePositiveInt(values["max-questions"], "--max-questions"),
      concurrency: parsePositiveInt(values.concurrency, "--concurrency"),
      callMaxAttempts: parsePositiveInt(values["call-attempts"], "--call-attempts"),
      callRetryDelayMs: parseIntOpt(values["retry-delay-ms"], "--retry-delay-ms"),
      force: values.force,
      videoIdOverride: values["video-id"],
      questionSkillPath: values["question-skill"],
      noSkill: values["no-skill"],
      onProgress: (msg) => console.error(msg),
    });
    console.log(JSON.stringify(summary, null, 2));
    if (Number(summary.errors ?? 0) > 0 || summary.integrityOk === false) {
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "judge") {
    const { values } = parseArgs({
      args: rest,
      options: {
        db: { type: "string" },
        split: { type: "string" },
        profile: { type: "string" },
        "video-id": { type: "string" },
        "question-ids": { type: "string" },
        "only-unjudged": { type: "boolean", default: false },
        "resume-unjudged": { type: "boolean", default: false },
        "max-turns": { type: "string" },
        "max-attempts": { type: "string" },
        concurrency: { type: "string" },
        "call-attempts": { type: "string" },
        "retry-delay-ms": { type: "string" },
        "no-skill": { type: "boolean", default: false },
        prompts: { type: "string" },
        "followup-skill": { type: "string" },
        "answer-style": { type: "string" },
        "quality-judge": { type: "string" },
        export: { type: "string" },
        system: { type: "string" },
        "system-file": { type: "string" },
        "no-search": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log(JUDGE_HELP);
      return;
    }
    const exportSystemPrompt = await readSystemPromptOption({
      system: values.system,
      systemFile: values["system-file"],
    });
    const summary = await runSynthJudgeWorkflow({
      dbPath: values.db,
      split: values.split !== undefined ? validateSplit(values.split, "--split") : undefined,
      profile: parseOptionalSynthProfile(values.profile),
      videoId: values["video-id"],
      questionIds: parseIdList(values["question-ids"], "--question-ids"),
      onlyUnjudged: values["only-unjudged"] || values["resume-unjudged"],
      maxTurns: parsePositiveInt(values["max-turns"], "--max-turns"),
      maxAttempts: parsePositiveInt(values["max-attempts"], "--max-attempts"),
      concurrency: parsePositiveInt(values.concurrency, "--concurrency"),
      callMaxAttempts: parsePositiveInt(values["call-attempts"], "--call-attempts"),
      callRetryDelayMs: parseIntOpt(values["retry-delay-ms"], "--retry-delay-ms"),
      noSkill: values["no-skill"],
      promptsDir: values.prompts,
      skillOverrides: {
        followupSkill: values["followup-skill"],
        answerStyle: values["answer-style"],
        qualityJudge: values["quality-judge"],
      },
      exportPath: values.export,
      exportSystemPrompt,
      ...(values["no-search"] ? { enableSearch: false } : {}),
      onProgress: (msg) => console.error(msg),
    });
    console.log(JSON.stringify(summary, null, 2));
    if (Number(summary.errors ?? 0) > 0 || summary.integrityOk === false) {
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "export") {
    const { values } = parseArgs({
      args: rest,
      options: {
        preset: { type: "string" },
        db: { type: "string" },
        "eval-db": { type: "string" },
        run: { type: "string" },
        runs: { type: "string" },
        "all-formal": { type: "boolean", default: false },
        split: { type: "string" },
        "exclude-runs": { type: "string" },
        "min-turns": { type: "string" },
        "max-turns": { type: "string" },
        dedup: { type: "string" },
        shuffle: { type: "boolean", default: false },
        seed: { type: "string" },
        out: { type: "string" },
        "val-out": { type: "string" },
        "val-ratio": { type: "string" },
        manifest: { type: "string" },
        timestamp: { type: "boolean", default: false },
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

    const preset = resolveSynthExportPreset(values.preset);
    if (values.run !== undefined && values.runs !== undefined) {
      throw new Error("--run 与 --runs 不能同时指定");
    }
    const runIds = values.run !== undefined
      ? [parsePositiveInt(values.run, "--run")!]
      : parseIdList(values.runs, "--runs");
    const systemPrompt = await readSystemPromptOption({
      system: values.system,
      systemFile: values["system-file"],
    });
    const valRatio = parseFloatOpt(values["val-ratio"], "--val-ratio")
      ?? (values["val-out"] !== undefined ? preset?.valRatio : undefined);

    const report = await runSynthExportWorkflow({
      dbPath: values.db,
      evalDbPath: values["eval-db"],
      runIds,
      allFormal: values["all-formal"] || (runIds === undefined && Boolean(preset?.allFormal)),
      split: values.split !== undefined ? validateSplit(values.split, "--split") : preset?.split,
      excludeRunIds: parseIdList(values["exclude-runs"], "--exclude-runs"),
      minTurns: parsePositiveInt(values["min-turns"], "--min-turns"),
      maxTurns: parsePositiveInt(values["max-turns"], "--max-turns"),
      dedup: parseDedupPolicy(values.dedup),
      shuffle: values.shuffle || Boolean(preset?.shuffle),
      seed: parseIntOpt(values.seed, "--seed") ?? preset?.seed,
      outPath: nonEmpty(values.out, "--out"),
      valOutPath: values["val-out"],
      valRatio,
      manifestPath: values.manifest,
      timestamp: values.timestamp || Boolean(preset?.timestamp),
      systemPrompt,
      generalizeTools: !values["no-generalize-tools"],
      negativeToolsRatio: parseFloatOpt(values["negative-tools-ratio"], "--negative-tools-ratio"),
    });
    console.log(JSON.stringify({ ...(preset ? { preset: preset.name } : {}), ...report }, null, 2));
    return;
  }

  if (sub === "demo") {
    const { values } = parseArgs({
      args: rest,
      options: {
        db: { type: "string" },
        "max-attempts": { type: "string" },
        export: { type: "string" },
        system: { type: "string" },
        "system-file": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log("用法：npm run dm -- synth demo [--db PATH] [--max-attempts N] [--export PATH] [--system TEXT]");
      return;
    }
    const exportSystemPrompt = await readSystemPromptOption({
      system: values.system,
      systemFile: values["system-file"],
    });
    const report = await runDemo({
      dbPath: values.db,
      maxAttempts: parsePositiveInt(values["max-attempts"], "--max-attempts"),
      exportPath: values.export,
      exportSystemPrompt,
      onProgress: (msg) => console.error(msg),
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  throw new Error(`未知 synth 子命令：${sub}（运行 npm run dm -- synth --help 查看可用命令）`);
}
