import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../shared/schema.js";
import { EVAL_BUILD_PRESETS, EVAL_IMPORT_PRESETS, EVAL_RUN_PRESETS } from "../eval/presets.js";
import { COT_BACKFILL_PRESETS, COT_EXPORT_PRESETS } from "../reasoning/presets.js";
import { SYNTH_EXPORT_PRESETS, SYNTH_RUN_PRESETS } from "../synth/presets.js";
import { runCotCli } from "./cot.js";
import { runEvalCli } from "./eval.js";
import { runSynthCli } from "./synth.js";

const ROOT_HELP = `pi-posttrain-loop 统一命令行入口（npm run dm -- <命令组> <子命令> [选项]）

命令组：
  synth      问答与多轮对话合成（status | run | questions | judge | export | demo）
  cot        脱稿思考链（CoT）逆向补写与导出（status | backfill | review | export）
  eval       独立评测库与对抗/陷阱盲测（init | status | mirror | import | build | calibrate | freeze | run | grade | evaluate | report | compare | inspect）
  demo       快捷入口：等价于 synth demo（30 秒离线演示，零 API Key）
  presets    列出全部内置预设名及参数说明

快速上手：
  npm run dm -- demo
  npm run dm -- presets
  npm run dm -- synth status
  npm run dm -- synth run --preset train-standard --limit 20
  npm run dm -- synth export --preset train-val --out output/train.jsonl --val-out output/val.jsonl
  npm run dm -- cot backfill --preset pilot --review-md output/cot-pilot.md
  npm run dm -- eval build --preset adv-full
  npm run dm -- eval evaluate --preset blind-gold --suite adv-main-v1 --candidate sft-v2 --out output/eval/sft-v2.md

使用 npm run dm -- <命令组> --help 查看各域详细用法。
`;

function formatPresetsSummary(): string {
  const sections: Array<[string, Record<string, { name: string; description: string }>]> = [
    ["synth run --preset", SYNTH_RUN_PRESETS],
    ["synth export --preset", SYNTH_EXPORT_PRESETS],
    ["cot backfill --preset", COT_BACKFILL_PRESETS],
    ["cot export --preset", COT_EXPORT_PRESETS],
    ["eval import --preset", EVAL_IMPORT_PRESETS],
    ["eval build --preset", EVAL_BUILD_PRESETS],
    ["eval run / evaluate --preset", EVAL_RUN_PRESETS],
  ];
  const lines = ["内置预设清单（任何显式 CLI 参数均可覆盖预设字段）：", ""];
  for (const [header, presets] of sections) {
    lines.push(`[${header}]`);
    for (const p of Object.values(presets)) {
      lines.push(`  ${p.name.padEnd(18)} ${p.description}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export async function runCli(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    console.log(ROOT_HELP);
    return;
  }

  const group = args[0]!;
  const rest = args.slice(1);

  if (group === "synth") {
    await runSynthCli(rest);
    return;
  }
  if (group === "cot") {
    await runCotCli(rest);
    return;
  }
  if (group === "eval") {
    await runEvalCli(rest);
    return;
  }
  if (group === "demo") {
    await runSynthCli(["demo", ...rest]);
    return;
  }
  if (group === "presets") {
    console.log(formatPresetsSummary());
    return;
  }

  throw new Error(`未知命令组：${group}（可选：synth、cot、eval、demo、presets；使用 --help 查看说明）`);
}

const isEntrypoint = process.argv[1] !== undefined
  && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isEntrypoint) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`错误：${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
