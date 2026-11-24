import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DataMakerStore, formatSamplesJsonl, sha256Hex, validateMaxTurns, type DedupPolicy } from "./db.js";
import { assertNoEvalLeak, readEvalVideoKeys } from "./eval-guard.js";
import { errorMessage, nonEmpty, validateSplit } from "./schema.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function parseRunIdList(raw: string, label: string): number[] {
  const ids = raw.split(",").map((part) => Number(part.trim()));
  if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error(`${label} 必须是以逗号分隔的正整数列表`);
  }
  return [...new Set(ids)];
}

const HELP = `从统一 SQLite 导出训练 JSONL（严格单行一条 {"messages":[...]}，支持单 run、多 run 合并与全库正式汇总）

单次运行导出：
  npm run export -- --run 8 --out output/run-8.jsonl

一键汇总全库所有正式样本（自动排除 training_enabled=false，同题默认取最新 run）：
  npm run export -- --all-formal --out output/train-all.jsonl

显式合并多个运行 + 打乱 + 按视频切分验证集 + 注入系统提示词 + 写审计清单：
  npm run export -- --runs 3,5,6,8 --out output/train.jsonl --val-out output/val.jsonl --val-ratio 0.1 --shuffle --seed 42 --manifest output/manifest.json --system "你的系统提示词"

参数：
  --run ID               导出单个 run_id（与 --runs、--all-formal、--version 互斥）
  --runs ID1,ID2,...     显式合并多个 run_id
  --all-formal           汇总全库指定分区（默认 train，自动排除 test/dpo 视频）所有正式 answer_judge 运行
  --version NAME         导出已冻结的测试集版本（如 test-v1；与 --run、--runs、--all-formal 互斥）
  --split SPLIT          数据集分区过滤：train（--all-formal 默认）| test | dpo
  --freeze-version NAME  可选（仅限 test/dpo 分区）：将本次导出的样本集同时固化为不可变版本（写入 test_set_versions）
  --exclude-runs IDs     排除指定 run_id（如 --exclude-runs 2）
  --min-turns N          仅导出对话轮数 >= N 的样本
  --max-turns N          仅导出对话轮数 <= N 的样本
  --dedup POLICY         同题多版本选版策略：latest（默认）| earliest | error
  --shuffle              打乱导出样本顺序
  --seed N               搭配 --shuffle 或 --val-ratio 使用的固定随机种子（整数）
  --out PATH             必填：训练/测试 JSONL 输出路径
  --val-out PATH         可选：验证集 JSONL 输出路径（需搭配 --val-ratio，按视频整块切分防泄漏）
  --val-ratio FLOAT      可选：验证集视频比例，(0, 1) 之间的小数（如 0.1）
  --manifest PATH        可选：将本次导出溯源与统计清单另存为 JSON 文件
  --system TEXT          可选：每条样本前统一注入一条 system 消息
  --system-file PATH     可选：从文件读取训练 system 提示词（与 --system 互斥）
  --db PATH              统一 SQLite 路径，默认 data/data-maker.sqlite
  --help                 查看说明
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      "eval-db": { type: "string" },
      run: { type: "string" },
      runs: { type: "string" },
      "all-formal": { type: "boolean", default: false },
      version: { type: "string" },
      split: { type: "string" },
      "freeze-version": { type: "string" },
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

  if (values.system !== undefined && values["system-file"] !== undefined) {
    throw new Error("--system 与 --system-file 不能同时指定");
  }
  if ((values["val-out"] !== undefined) !== (values["val-ratio"] !== undefined)) {
    throw new Error("--val-out 与 --val-ratio 必须成对指定");
  }

  const modeCount = [
    values.run !== undefined,
    values.runs !== undefined,
    Boolean(values["all-formal"]),
    values.version !== undefined,
  ].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new Error("请在 --run、--runs、--all-formal、--version 中恰好指定一种选取模式");
  }

  const targetSplit = values.split !== undefined ? validateSplit(values.split, "--split") : undefined;
  if (values["freeze-version"] !== undefined) {
    const freezeSplit = targetSplit ?? "test";
    if (freezeSplit === "train") {
      throw new Error("--freeze-version 仅适用于 --split test 或 --split dpo");
    }
  }

  const outPath = resolve(nonEmpty(values.out, "--out"));
  const dbPath = resolve(values.db ?? join(ROOT, "data/data-maker.sqlite"));

  let runIds: number[] | undefined;
  if (values.run !== undefined) {
    const id = Number(nonEmpty(values.run, "--run"));
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("--run 必须是正整数");
    runIds = [id];
  } else if (values.runs !== undefined) {
    runIds = parseRunIdList(values.runs, "--runs");
  }

  const excludeRunIds = values["exclude-runs"] !== undefined
    ? parseRunIdList(values["exclude-runs"], "--exclude-runs")
    : undefined;
  const minTurns = values["min-turns"] !== undefined ? validateMaxTurns(Number(values["min-turns"])) : undefined;
  const maxTurns = values["max-turns"] !== undefined ? validateMaxTurns(Number(values["max-turns"])) : undefined;
  const dedup = (values.dedup ?? "latest") as DedupPolicy;
  const seed = values.seed !== undefined ? Number(values.seed) : undefined;
  if (seed !== undefined && !Number.isSafeInteger(seed)) {
    throw new Error("--seed 必须是整数");
  }
  const valRatio = values["val-ratio"] !== undefined ? Number(values["val-ratio"]) : undefined;

  let systemPrompt: string | undefined;
  if (values.system !== undefined) {
    systemPrompt = nonEmpty(values.system, "--system");
  } else if (values["system-file"] !== undefined) {
    systemPrompt = nonEmpty(await readFile(resolve(values["system-file"]), "utf8"), "--system-file");
  }

  const store = new DataMakerStore(dbPath, { readOnly: values["freeze-version"] === undefined });
  try {
    let frozenVersion: { id: number; name: string; split: "test" | "dpo"; sampleCount: number; videoCount: number; sha256: string } | undefined;
    if (values["freeze-version"] !== undefined) {
      const freezeSplit = (targetSplit ?? "test") as "test" | "dpo";
      const ver = store.freezeTestSetVersion({
        name: nonEmpty(values["freeze-version"], "--freeze-version"),
        split: freezeSplit,
        runIds,
        dedup,
        minTurns,
        maxTurns,
        systemPrompt,
      });
      frozenVersion = {
        id: ver.id,
        name: ver.name,
        split: ver.split,
        sampleCount: ver.sample_count,
        videoCount: ver.video_count,
        sha256: ver.sha256,
      };
    }

    const merged = store.exportMergedDataset({
      runIds,
      allFormal: Boolean(values["all-formal"]),
      split: targetSplit,
      versionName: values.version,
      excludeRunIds,
      minTurns,
      maxTurns,
      dedup,
      shuffle: Boolean(values.shuffle),
      seed,
      valRatio,
      systemPrompt,
    });

    const isTrainingExport = values.version === undefined && (targetSplit === undefined || targetSplit === "train");
    if (isTrainingExport) {
      const evalDbPath = resolve(values["eval-db"] ?? join(dirname(dbPath), "eval.sqlite"));
      const evalVideoKeys = readEvalVideoKeys(evalDbPath);
      if (evalVideoKeys.size > 0) {
        const materialInfo = store.getMaterialVideoAndSplitMap();
        const exportedVideoKeys = [...merged.train, ...merged.val].map(
          (r) => materialInfo.get(r.materialId)?.videoKey ?? String(r.materialId),
        );
        assertNoEvalLeak(exportedVideoKeys, evalVideoKeys, "训练导出");
      }
    }

    const trainJsonl = formatSamplesJsonl(merged.train.map((r) => r.sample));
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, trainJsonl, "utf8");

    let valOutPath: string | undefined;
    let valSha256: string | undefined;
    if (values["val-out"] !== undefined) {
      valOutPath = resolve(nonEmpty(values["val-out"], "--val-out"));
      const valJsonl = formatSamplesJsonl(merged.val.map((r) => r.sample));
      await mkdir(dirname(valOutPath), { recursive: true });
      await writeFile(valOutPath, valJsonl, "utf8");
      valSha256 = sha256Hex(valJsonl);
    }

    const report = {
      exportedAt: new Date().toISOString(),
      db: dbPath,
      mode: values.version !== undefined
        ? "version"
        : values["all-formal"]
          ? "all-formal"
          : values.runs !== undefined
            ? "runs"
            : "single-run",
      ...(targetSplit !== undefined ? { split: targetSplit } : values["all-formal"] ? { split: "train" } : {}),
      ...(values.version !== undefined ? { version: values.version } : {}),
      ...(frozenVersion !== undefined ? { frozenVersion } : {}),
      dedup,
      includedRunIds: merged.includedRunIds,
      countsByRunId: merged.countsByRunId,
      duplicateQuestionsResolved: merged.duplicateQuestionsResolved,
      turnCountDistribution: merged.turnCountDistribution,
      materialCount: merged.materialCount,
      trainMaterialCount: merged.trainMaterialCount,
      valMaterialCount: merged.valMaterialCount,
      exported: merged.train.length,
      trainSamples: merged.train.length,
      valSamples: merged.val.length,
      hasSystemPrompt: systemPrompt !== undefined,
      shuffled: Boolean(values.shuffle),
      ...(seed !== undefined ? { seed } : {}),
      out: outPath,
      outSha256: sha256Hex(trainJsonl),
      ...(valOutPath ? { valOut: valOutPath, valSha256 } : {}),
    };

    if (values.manifest !== undefined) {
      const manifestPath = resolve(nonEmpty(values.manifest, "--manifest"));
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    }

    console.log(JSON.stringify(report, null, 2));
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(`错误：${errorMessage(error)}`);
  process.exitCode = 1;
});
