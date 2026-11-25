#!/usr/bin/env python3
"""Prepare and publish pi-posttrain-loop CoT SFT & Eval datasets to ModelScope.

Subcommands:
  prepare  Validate source JSONL/manifest files, sanitize local paths, assemble
           the ModelScope release folder (default: output/modelscope-release/),
           and generate the dataset card README.md + SHA256SUMS.txt.
  upload   Create (optional) and upload the prepared release folder to a
           ModelScope dataset repository using modelscope_hub / modelscope.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_RELEASE_DIR = REPO_ROOT / "output" / "modelscope-release"
DEFAULT_SOURCES = {
    "cot_train": REPO_ROOT / "output" / "train-cot-all-formal-20261125-022709-train.jsonl",
    "cot_val": REPO_ROOT / "output" / "train-cot-all-formal-20261125-022709-val.jsonl",
    "cot_manifest": REPO_ROOT / "output" / "train-cot-all-formal-20261125-022709-manifest.json",
    "eval_adv": REPO_ROOT / "output" / "eval" / "adv-main-v1.jsonl",
    "eval_adv_manifest": REPO_ROOT / "output" / "eval" / "adv-main-v1.manifest.json",
    "eval_trap": REPO_ROOT / "output" / "eval" / "trap-main-v1.jsonl",
    "eval_trap_manifest": REPO_ROOT / "output" / "eval" / "trap-main-v1.manifest.json",
}

EXPECTED_COT_KEYS = ("messages",)
EXPECTED_EVAL_KEYS = (
    "difficulty",
    "expectedBehavior",
    "itemKey",
    "messages",
    "persona",
    "probeType",
    "rubrics",
    "videoKey",
)

ABS_PATH_LEAK_RE = re.compile(
    r"(?:[A-Za-z]:\\(?:Users|WorkSpace|Workspace|home)\\|/Users/|/home/)",
    re.IGNORECASE,
)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def format_size(num_bytes: int) -> str:
    if num_bytes >= 1024 * 1024:
        return f"{num_bytes / (1024 * 1024):.2f} MB"
    if num_bytes >= 1024:
        return f"{num_bytes / 1024:.2f} KB"
    return f"{num_bytes} B"


def validate_jsonl(
    path: Path,
    *,
    expected_keys: tuple[str, ...],
    require_think: bool = False,
) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"Source file not found: {path}")

    line_count = 0
    turn_dist: dict[int, int] = {}
    asst_lens: list[int] = []

    with path.open("r", encoding="utf-8") as f:
        for line_no, raw_line in enumerate(f, start=1):
            line = raw_line.strip()
            if not line:
                raise ValueError(f"{path.name}: empty line at line {line_no}")
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path.name}: invalid JSON at line {line_no}: {exc}") from exc

            if not isinstance(obj, dict):
                raise ValueError(f"{path.name}: line {line_no} is not a JSON object")

            actual_keys = tuple(sorted(obj.keys()))
            if actual_keys != expected_keys:
                raise ValueError(
                    f"{path.name}: schema mismatch at line {line_no}: "
                    f"expected {expected_keys}, got {actual_keys}"
                )

            messages = obj.get("messages")
            if not isinstance(messages, list) or len(messages) < 2:
                raise ValueError(f"{path.name}: invalid messages at line {line_no}")

            turn_dist[len(messages)] = turn_dist.get(len(messages), 0) + 1
            last_msg = messages[-1]
            if last_msg.get("role") != "assistant" or not isinstance(last_msg.get("content"), str):
                raise ValueError(f"{path.name}: last message is not assistant string at line {line_no}")

            content = last_msg["content"]
            asst_lens.append(len(content))
            if require_think:
                if "<think>" not in content or "</think>" not in content:
                    raise ValueError(
                        f"{path.name}: missing <think>...</think> in assistant reply at line {line_no}"
                    )
            line_count += 1

    if line_count == 0:
        raise ValueError(f"{path.name}: file has 0 records")

    asst_lens.sort()
    return {
        "lines": line_count,
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "msg_len_dist": dict(sorted(turn_dist.items())),
        "last_asst_chars": {
            "min": asst_lens[0],
            "p50": asst_lens[len(asst_lens) // 2],
            "p95": asst_lens[int(len(asst_lens) * 0.95)],
            "max": asst_lens[-1],
        },
    }


def sanitize_value(value: Any, path_replacements: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {k: sanitize_value(v, path_replacements) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize_value(v, path_replacements) for v in value]
    if isinstance(value, str):
        normalized = value.replace("\\", "/")
        for src, dst in path_replacements.items():
            if normalized.lower() == src.lower():
                return dst
        repo_norm = str(REPO_ROOT).replace("\\", "/")
        if normalized.lower().startswith(repo_norm.lower() + "/"):
            return normalized[len(repo_norm) + 1 :]
        if ABS_PATH_LEAK_RE.search(value):
            return Path(normalized).name
    return value


def build_readme(
    *,
    repo_id: str,
    cot_manifest: dict[str, Any],
    adv_manifest: dict[str, Any],
    trap_manifest: dict[str, Any],
    stats: dict[str, dict[str, Any]],
) -> str:
    train_s = stats["cot_train"]
    val_s = stats["cot_val"]
    adv_s = stats["eval_adv"]
    trap_s = stats["eval_trap"]

    total_cot = train_s["lines"] + val_s["lines"]
    prof_dist = cot_manifest.get("profileDistribution", {})
    turn_dist = cot_manifest.get("turnNoDistribution", {})
    tier_dist = cot_manifest.get("tierDistribution", {})

    adv_types = adv_manifest.get("byType", {})
    adv_diff = adv_manifest.get("byDifficulty", {})
    adv_overlap = adv_manifest.get("trainOverlapScan", {})

    trap_types = trap_manifest.get("byType", {})
    trap_diff = trap_manifest.get("byDifficulty", {})
    trap_overlap = trap_manifest.get("trainOverlapScan", {})

    return f"""---
license: other
language:
  - zh
task_categories:
  - text-generation
  - question-answering
tags:
  - cot
  - sft
  - reasoning
  - multi-turn
  - adversarial-eval
  - chinese
  - philosophy
  - ms-swift
pretty_name: pi-posttrain-loop CoT SFT & Adversarial Eval Dataset
configs:
  - config_name: cot_sft
    default: true
    data_files:
      - split: train
        path: data/cot_sft/train.jsonl
      - split: validation
        path: data/cot_sft/val.jsonl
  - config_name: eval_adv
    data_files:
      - split: test
        path: data/eval/adv-main-v1.jsonl
  - config_name: eval_trap
    data_files:
      - split: test
        path: data/eval/trap-main-v1.jsonl
---

# pi-posttrain-loop CoT 训练集与对抗评测集

本数据集由开源数据工程流水线 [pi-posttrain-loop](https://github.com/chosenecho/pi-posttrain-loop) 生成并冻结，包含两部分物理隔离的数据资产：

1. **脱稿思维链（CoT）SFT 训练集与验证集（`cot_sft`）**：共 **{total_cot:,}** 条展开多轮样本（训练集 {train_s['lines']:,} 条 / 验证集 {val_s['lines']:,} 条），均包含无原稿第一人称逆向补写的 `<think>...</think>` 思考过程与正式回答，直接适配 `ms-swift` 等主流后训练框架。
2. **独立对抗盲测套件（`eval_adv` / `eval_trap`）**：从完全隔离的 `test` 视频分区构建的冻结评测卷，包含 **134 题综合对抗主卷（`adv-main-v1`）** 与 **96 题陷阱拒答主卷（`trap-main-v1`）**，每题附带结构化多维评分卡（`rubrics`）与参考回答。

> **防泄漏提示**：`data/eval/` 下的 `adv-main-v1.jsonl` 与 `trap-main-v1.jsonl` 为严格隔离的评测测试集，**请勿用于任何形式的模型训练或微调**。

---

## 1. 仓库目录与数据概览

```text
.
├── README.md
├── data/
│   ├── cot_sft/
│   │   ├── train.jsonl              # CoT SFT 训练集（{train_s['lines']:,} 条，{format_size(train_s['bytes'])}）
│   │   └── val.jsonl                # CoT SFT 验证集（{val_s['lines']:,} 条，{format_size(val_s['bytes'])}）
│   └── eval/
│       ├── adv-main-v1.jsonl        # 综合对抗评测主卷（{adv_s['lines']} 题 / {adv_manifest.get('turnCount', 141)} 轮，{format_size(adv_s['bytes'])}）
│       └── trap-main-v1.jsonl       # 陷阱拒答评测主卷（{trap_s['lines']} 题 / {trap_manifest.get('turnCount', 142)} 轮，{format_size(trap_s['bytes'])}）
└── manifests/
    ├── cot-sft-manifest.json        # CoT 导出统计与推荐训练参数
    ├── adv-main-v1.manifest.json    # adv-main-v1 冻结审计清单（含训练集 3-gram 重合扫描）
    ├── trap-main-v1.manifest.json   # trap-main-v1 冻结审计清单（含训练集 3-gram 重合扫描）
    └── SHA256SUMS.txt               # 全部文件 SHA-256 校验值
```

| 子集 (`config_name`) | Split | 文件路径 | 样本数 | 视频来源数 | 体积 | 用途 |
| :--- | :--- | :--- | ---: | ---: | ---: | :--- |
| `cot_sft` *(default)* | `train` | `data/cot_sft/train.jsonl` | {train_s['lines']:,} | {cot_manifest.get('trainVideoCount', 1271):,} | {format_size(train_s['bytes'])} | CoT SFT 训练 |
| `cot_sft` *(default)* | `validation` | `data/cot_sft/val.jsonl` | {val_s['lines']:,} | {cot_manifest.get('valVideoCount', 67):,} | {format_size(val_s['bytes'])} | 训练期验证集（按视频去重划分） |
| `eval_adv` | `test` | `data/eval/adv-main-v1.jsonl` | {adv_s['lines']} | {adv_manifest.get('videoCount', 33)} | {format_size(adv_s['bytes'])} | 6 类综合实战对抗盲测 |
| `eval_trap` | `test` | `data/eval/trap-main-v1.jsonl` | {trap_s['lines']} | {trap_manifest.get('videoCount', 34)} | {format_size(trap_s['bytes'])} | 4 类边界拒答与防幻觉盲测 |

---

## 2. 子集详情与数据格式

### 2.1 CoT SFT 数据集（`cot_sft`）

- **构建方法**：
  - 全部原始视频在 SQLite 中按归一化 `video_key` 持久化锁定为 `train` / `test` / `dpo` 三个互不重叠的分区，`cot_sft` 仅来源于 `train` 分区，并按视频维度划分训练与验证集（`seed = {cot_manifest.get('seed', 42)}`，已打乱）。
  - 采用无状态多角色问答合成 + 盲审返工质检后，再在不提供原稿（`material`）的条件下逆向补写第一人称思考链（`<think>...</think>`），并经过确定性反抄袭/反上帝视角校验与 `reasoning-judge` 二次复核。
  - `expandTurns = true`：多轮对话按轮次展开，历史轮次仅保留干净问答上下文，**末轮 `assistant` 回复包含内联 `<think>...</think>` 与正式回答**（建议配合 `loss_scale=last_round` 训练）。
- **统计分布（train + validation 合计 {total_cot:,} 条）**：
  - **风格配比**：`standard` {prof_dist.get('standard', 0):,} 条 / `short` {prof_dist.get('short', 0):,} 条
  - **轮次分布**：第 1 轮 {turn_dist.get('1', 0):,} 条 / 第 2 轮 {turn_dist.get('2', 0):,} 条 / 第 3 轮 {turn_dist.get('3', 0):,} 条
  - **篇幅档位**：`short` {tier_dist.get('short', 0):,} 条 / `medium` {tier_dist.get('medium', 0):,} 条 / `long` {tier_dist.get('long', 0):,} 条
  - **末轮 assistant 字符长度（训练集）**：最小 {train_s['last_asst_chars']['min']} / 中位数 {train_s['last_asst_chars']['p50']} / P95 {train_s['last_asst_chars']['p95']} / 最大 {train_s['last_asst_chars']['max']}
- **JSONL Schema**：
```json
{{
  "messages": [
    {{"role": "user", "content": "问题文本..."}},
    {{"role": "assistant", "content": "<think>\\n内省推理过程...\\n</think>\\n\\n正式回答正文..."}}
  ]
}}
```

### 2.2 综合对抗评测主卷（`eval_adv` / `adv-main-v1.jsonl`）

- **来源与防泄漏审计**：全部 33 个视频均来自物理隔离的 `test` 分区；与训练集问题的 3-gram Jaccard 最大相似度为 **{adv_overlap.get('maxSimilarity', 0.125)}**（阈值 `{adv_overlap.get('threshold', 0.6)}`，超阈数 `{adv_overlap.get('aboveThresholdCount', 0)}`）。
- **题型分布（共 134 题 / {adv_manifest.get('turnCount', 141)} 轮）**：
  - `wild_short`（野生短问）：{adv_types.get('wild_short', 0)}
  - `premise_trap`（错误前提陷阱）：{adv_types.get('premise_trap', 0)}
  - `contrast`（易混概念辨析）：{adv_types.get('contrast', 0)}
  - `transfer`（现实场景迁移）：{adv_types.get('transfer', 0)}
  - `hallucination_bait`（越界幻觉诱导）：{adv_types.get('hallucination_bait', 0)}
  - `pressure`（多轮连续施压）：{adv_types.get('pressure', 0)}
- **难度标定**：`hard` {adv_diff.get('hard', 0)} / `medium` {adv_diff.get('medium', 0)} / `easy` {adv_diff.get('easy', 0)}（easy 占比 {adv_manifest.get('easyRatio', 0):.2%}）。

### 2.3 陷阱拒答评测主卷（`eval_trap` / `trap-main-v1.jsonl`）

- **来源与防泄漏审计**：全部 34 个视频均来自 `test` 分区；与训练集问题的 3-gram Jaccard 最大相似度为 **{trap_overlap.get('maxSimilarity', 0.1786)}**（阈值 `{trap_overlap.get('threshold', 0.6)}`，超阈数 `{trap_overlap.get('aboveThresholdCount', 0)}`）。
- **题型分布（共 96 题 / {trap_manifest.get('turnCount', 142)} 轮）**：
  - `trap_unknown_detail`（未知细节追问）：{trap_types.get('trap_unknown_detail', 0)}
  - `trap_misattribution`（错误归因 / 伪造引文）：{trap_types.get('trap_misattribution', 0)}
  - `trap_unfounded_judgment`（无根据定性诱导）：{trap_types.get('trap_unfounded_judgment', 0)}
  - `trap_forced_decision`（强迫替人做人生/现实决策）：{trap_types.get('trap_forced_decision', 0)}
- **难度标定**：`hard` {trap_diff.get('hard', 0)} / `medium` {trap_diff.get('medium', 0)} / `easy` {trap_diff.get('easy', 0)}。

- **评测卷统一 JSONL Schema（`eval_adv` 与 `eval_trap`）**：
```json
{{
  "itemKey": "probe:1",
  "videoKey": "BV17P4y1B7b3",
  "probeType": "wild_short",
  "expectedBehavior": "answer",
  "difficulty": "hard",
  "persona": "打工人",
  "messages": [
    {{"role": "user", "content": "评测问题（多轮题含追问）"}},
    {{"role": "assistant", "content": "参考回答（用于批卷对照，非训练目标）"}}
  ],
  "rubrics": [
    {{
      "turnNo": 1,
      "expectedBehavior": "answer",
      "tactic": null,
      "rubric": {{
        "expectedBehavior": "answer",
        "stance": "核心立场要求",
        "keyPoints": ["要点1", "要点2"],
        "forbidden": ["禁止出现的错误"],
        "mustNotHallucinate": ["禁止编造的事实"],
        "failureSignals": ["判定失败信号"]
      }}
    }}
  ]
}}
```

---

## 3. 快速使用方式

### 3.1 使用 ModelScope CLI 下载数据文件

```bash
pip install modelscope
modelscope download --dataset {repo_id} --local_dir ./pi-posttrain-dataset
```

### 3.2 使用 `MsDataset` 加载指定子集

```python
from modelscope.msdatasets import MsDataset

# 加载 CoT SFT 训练集与验证集
train_ds = MsDataset.load("{repo_id}", subset_name="cot_sft", split="train")
val_ds = MsDataset.load("{repo_id}", subset_name="cot_sft", split="validation")

# 加载独立对抗评测集（仅用于评测）
adv_ds = MsDataset.load("{repo_id}", subset_name="eval_adv", split="test")
trap_ds = MsDataset.load("{repo_id}", subset_name="eval_trap", split="test")
```

### 3.3 配合 `ms-swift` 执行 CoT SFT 微调参考命令

`cot-sft-manifest.json` 中记录的推荐关键参数示例（下载至本地后直接传入）：

```bash
swift sft \\
  --model <your-base-model> \\
  --dataset ./pi-posttrain-dataset/data/cot_sft/train.jsonl \\
  --val_dataset ./pi-posttrain-dataset/data/cot_sft/val.jsonl \\
  --use_chat_template true \\
  --enable_thinking true \\
  --loss_scale last_round
```

---

## 4. 内容来源与权利声明（重要）

1. **原始语料来源**：本数据集基于哔哩哔哩账号「未明子」（UID `23191782`，[主页链接](https://space.bilibili.com/23191782)）公开视频及相关归档文稿合成与构造。评测卷元数据中的 `videoKey`（BV 号 / YouTube ID）仅用于追溯与分区防泄漏校验，**不表示原作者或平台对本数据集的认可或背书**。
2. **原作品权利归属**：原作者对其原创作品依法享有的著作权及相关权利，均由原权利人保留；涉及合作创作、引用及其他第三方素材的权利归相应权利人所有。数据合成、整理、转录与导出不改变原作品的权利归属。
3. **使用边界与许可说明**：
   - 本仓库对所包含的合成语料数据**不授予统一商用或再授权许可**，仅面向学术研究、后训练数据工程方法复现与评测实验交流。
   - 任何转载、二次改编、商业使用或超出法定合理使用范围的模型训练行为，请自行遵循原权利人公布的许可及适用法律法规，必要时向原权利人取得授权。
   - 生成本数据集所使用的工具代码与流水线脚本见 [pi-posttrain-loop](https://github.com/chosenecho/pi-posttrain-loop)（代码部分遵循 MIT License）。
4. **权利反馈**：如权利人或相关方认为本数据集中的任何内容涉及侵权或需要调整/下架，请通过 ModelScope 讨论区或关联代码仓库 Issues 联系，我们将及时配合处理。
"""


def cmd_prepare(args: argparse.Namespace) -> int:
    release_dir = Path(args.release_dir).resolve()
    data_cot_dir = release_dir / "data" / "cot_sft"
    data_eval_dir = release_dir / "data" / "eval"
    manifests_dir = release_dir / "manifests"

    sources = {
        "cot_train": Path(args.cot_train).resolve(),
        "cot_val": Path(args.cot_val).resolve(),
        "cot_manifest": Path(args.cot_manifest).resolve(),
        "eval_adv": Path(args.eval_adv).resolve(),
        "eval_adv_manifest": Path(args.eval_adv_manifest).resolve(),
        "eval_trap": Path(args.eval_trap).resolve(),
        "eval_trap_manifest": Path(args.eval_trap_manifest).resolve(),
    }

    print("[1/5] Validating source JSONL files...")
    stats = {
        "cot_train": validate_jsonl(
            sources["cot_train"], expected_keys=EXPECTED_COT_KEYS, require_think=True
        ),
        "cot_val": validate_jsonl(
            sources["cot_val"], expected_keys=EXPECTED_COT_KEYS, require_think=True
        ),
        "eval_adv": validate_jsonl(
            sources["eval_adv"], expected_keys=EXPECTED_EVAL_KEYS, require_think=False
        ),
        "eval_trap": validate_jsonl(
            sources["eval_trap"], expected_keys=EXPECTED_EVAL_KEYS, require_think=False
        ),
    }

    cot_manifest_raw = json.loads(sources["cot_manifest"].read_text(encoding="utf-8"))
    adv_manifest_raw = json.loads(sources["eval_adv_manifest"].read_text(encoding="utf-8"))
    trap_manifest_raw = json.loads(sources["eval_trap_manifest"].read_text(encoding="utf-8"))

    # Verify SHA-256 matches source manifests
    checks = [
        ("cot_train", stats["cot_train"]["sha256"], cot_manifest_raw.get("outSha256")),
        ("cot_val", stats["cot_val"]["sha256"], cot_manifest_raw.get("valSha256")),
        ("eval_adv", stats["eval_adv"]["sha256"], adv_manifest_raw.get("sha256")),
        ("eval_trap", stats["eval_trap"]["sha256"], trap_manifest_raw.get("sha256")),
    ]
    for label, actual_sha, expected_sha in checks:
        if expected_sha and actual_sha != expected_sha:
            raise ValueError(
                f"SHA-256 mismatch for {label}: actual={actual_sha}, manifest={expected_sha}"
            )
    print("  All 4 JSONL files passed schema, <think>, and manifest SHA-256 checks.")

    print(f"[2/5] Assembling release directory: {release_dir}")
    data_cot_dir.mkdir(parents=True, exist_ok=True)
    data_eval_dir.mkdir(parents=True, exist_ok=True)
    manifests_dir.mkdir(parents=True, exist_ok=True)

    copy_plan = [
        (sources["cot_train"], data_cot_dir / "train.jsonl"),
        (sources["cot_val"], data_cot_dir / "val.jsonl"),
        (sources["eval_adv"], data_eval_dir / "adv-main-v1.jsonl"),
        (sources["eval_trap"], data_eval_dir / "trap-main-v1.jsonl"),
    ]
    for src, dst in copy_plan:
        shutil.copy2(src, dst)
        print(f"  Copied {src.name} -> {dst.relative_to(release_dir)} ({format_size(dst.stat().st_size)})")

    print("[3/5] Sanitizing and writing manifests...")
    replacements = {
        str(sources["cot_train"]).replace("\\", "/"): "data/cot_sft/train.jsonl",
        str(sources["cot_val"]).replace("\\", "/"): "data/cot_sft/val.jsonl",
        str(REPO_ROOT / "data" / "data-maker.sqlite").replace("\\", "/"): "data/data-maker.sqlite",
    }

    cot_manifest = sanitize_value(cot_manifest_raw, replacements)
    cot_manifest["sourceFiles"] = {
        "train": sources["cot_train"].name,
        "validation": sources["cot_val"].name,
    }
    adv_manifest = sanitize_value(adv_manifest_raw, replacements)
    adv_manifest["packagedPath"] = "data/eval/adv-main-v1.jsonl"
    trap_manifest = sanitize_value(trap_manifest_raw, replacements)
    trap_manifest["packagedPath"] = "data/eval/trap-main-v1.jsonl"

    manifest_outputs = [
        (manifests_dir / "cot-sft-manifest.json", cot_manifest),
        (manifests_dir / "adv-main-v1.manifest.json", adv_manifest),
        (manifests_dir / "trap-main-v1.manifest.json", trap_manifest),
    ]
    for dst, payload in manifest_outputs:
        dst.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # Write SHA256SUMS.txt
    sum_files = [
        data_cot_dir / "train.jsonl",
        data_cot_dir / "val.jsonl",
        data_eval_dir / "adv-main-v1.jsonl",
        data_eval_dir / "trap-main-v1.jsonl",
        manifests_dir / "cot-sft-manifest.json",
        manifests_dir / "adv-main-v1.manifest.json",
        manifests_dir / "trap-main-v1.manifest.json",
    ]
    sha_lines = [
        f"{sha256_file(p)}  {p.relative_to(release_dir).as_posix()}"
        for p in sum_files
    ]
    (manifests_dir / "SHA256SUMS.txt").write_text("\n".join(sha_lines) + "\n", encoding="utf-8")

    print("[4/5] Generating ModelScope dataset card (README.md)...")
    readme_path = release_dir / "README.md"
    if args.keep_readme and readme_path.exists():
        print("  Skipped README.md overwrite (--keep-readme).")
    else:
        readme_text = build_readme(
            repo_id=args.repo_id or "<your-namespace>/<dataset-name>",
            cot_manifest=cot_manifest,
            adv_manifest=adv_manifest,
            trap_manifest=trap_manifest,
            stats=stats,
        )
        readme_path.write_text(readme_text, encoding="utf-8")

    print("[5/5] Running final release hygiene checks...")
    leaks: list[str] = []
    for p in [readme_path, *(d for d, _ in manifest_outputs), manifests_dir / "SHA256SUMS.txt"]:
        txt = p.read_text(encoding="utf-8")
        if ABS_PATH_LEAK_RE.search(txt):
            leaks.append(p.relative_to(release_dir).as_posix())
    if leaks:
        raise RuntimeError(f"Detected local absolute path leak in: {leaks}")

    total_bytes = sum(p.stat().st_size for p in release_dir.rglob("*") if p.is_file())
    print(f"Release package ready at: {release_dir}")
    print(f"Total size: {format_size(total_bytes)}")
    return 0


def cmd_upload(args: argparse.Namespace) -> int:
    release_dir = Path(args.release_dir).resolve()
    if not release_dir.is_dir():
        raise FileNotFoundError(
            f"Release directory not found: {release_dir}. Run 'prepare' first."
        )

    repo_id = args.repo_id.strip()
    if "/" not in repo_id or len(repo_id.split("/")) != 2 or not all(repo_id.split("/")):
        raise ValueError(f"Invalid --repo-id '{repo_id}'. Expected format: <namespace>/<dataset-name>")

    required_rel = [
        "README.md",
        "data/cot_sft/train.jsonl",
        "data/cot_sft/val.jsonl",
        "data/eval/adv-main-v1.jsonl",
        "data/eval/trap-main-v1.jsonl",
        "manifests/cot-sft-manifest.json",
        "manifests/adv-main-v1.manifest.json",
        "manifests/trap-main-v1.manifest.json",
        "manifests/SHA256SUMS.txt",
    ]
    missing = [r for r in required_rel if not (release_dir / r).is_file()]
    if missing:
        raise FileNotFoundError(f"Release directory is incomplete; missing: {missing}")

    # Optionally patch README placeholder repo_id before uploading
    readme_path = release_dir / "README.md"
    readme_text = readme_path.read_text(encoding="utf-8")
    if "<your-namespace>/<dataset-name>" in readme_text:
        if args.dry_run:
            print(f"[dry-run] Note: README.md still contains '<your-namespace>/<dataset-name>'; "
                  f"will be replaced with '{repo_id}' on upload.")
        else:
            readme_path.write_text(
                readme_text.replace("<your-namespace>/<dataset-name>", repo_id),
                encoding="utf-8",
            )
            print(f"Updated README.md dataset ID placeholder -> {repo_id}")

    files = sorted(
        p for p in release_dir.rglob("*")
        if p.is_file() and ".ms_upload_cache" not in p.parts
    )
    total_bytes = sum(p.stat().st_size for p in files)

    print("=== ModelScope Upload Plan ===")
    print(f"  Repo ID    : {repo_id} (repo_type=dataset)")
    print(f"  Visibility : {args.visibility}")
    print(f"  License    : {args.license}")
    print(f"  Create repo: {args.create}")
    print(f"  Source dir : {release_dir}")
    print(f"  Files ({len(files)}, total {format_size(total_bytes)}):")
    for f in files:
        print(f"    - {f.relative_to(release_dir).as_posix()} ({format_size(f.stat().st_size)})")

    if args.dry_run:
        print("\n[dry-run] Validation passed. No network requests were made.")
        return 0

    token = args.token or os.environ.get("MODELSCOPE_API_TOKEN")
    from modelscope_hub.api import HubApi
    from modelscope_hub.errors import AlreadyExistsError

    api = HubApi(token=token)
    if not token and not api._config.token:
        raise RuntimeError(
            "No ModelScope token found. Set MODELSCOPE_API_TOKEN, pass --token, "
            "or run 'modelscope login --token <YOUR_TOKEN>' first."
        )

    if args.create:
        print(f"\nCreating dataset repository '{repo_id}' (visibility={args.visibility})...")
        try:
            api.create_repo(
                repo_id=repo_id,
                repo_type="dataset",
                visibility=args.visibility,
                license=args.license,
                chinese_name=args.chinese_name,
                description=args.description,
            )
            print("  Repository created.")
        except AlreadyExistsError:
            print("  Repository already exists; continuing with upload.")

    print(f"\nUploading folder to ModelScope dataset '{repo_id}'...")
    api.upload_folder(
        repo_id=repo_id,
        repo_type="dataset",
        folder_path=release_dir,
        commit_message=args.commit_message,
        ignore_patterns=[".ms_upload_cache/*", ".ms_upload_cache/**", "*.tmp", ".DS_Store", "Thumbs.db"],
        revision=args.revision,
    )
    print(f"\nUpload complete! View dataset at: https://modelscope.cn/datasets/{repo_id}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Prepare and publish CoT SFT & Eval datasets to ModelScope."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_prep = subparsers.add_parser("prepare", help="Validate and assemble local ModelScope release folder")
    p_prep.add_argument("--release-dir", default=str(DEFAULT_RELEASE_DIR))
    p_prep.add_argument("--repo-id", default="", help="Optional namespace/dataset-name to embed in README examples")
    p_prep.add_argument("--keep-readme", action="store_true", help="Do not overwrite an existing README.md")
    p_prep.add_argument("--cot-train", default=str(DEFAULT_SOURCES["cot_train"]))
    p_prep.add_argument("--cot-val", default=str(DEFAULT_SOURCES["cot_val"]))
    p_prep.add_argument("--cot-manifest", default=str(DEFAULT_SOURCES["cot_manifest"]))
    p_prep.add_argument("--eval-adv", default=str(DEFAULT_SOURCES["eval_adv"]))
    p_prep.add_argument("--eval-adv-manifest", default=str(DEFAULT_SOURCES["eval_adv_manifest"]))
    p_prep.add_argument("--eval-trap", default=str(DEFAULT_SOURCES["eval_trap"]))
    p_prep.add_argument("--eval-trap-manifest", default=str(DEFAULT_SOURCES["eval_trap_manifest"]))
    p_prep.set_defaults(func=cmd_prepare)

    p_up = subparsers.add_parser("upload", help="Create (optional) and upload release folder to ModelScope")
    p_up.add_argument("--repo-id", required=True, help="Target dataset ID: <namespace>/<dataset-name>")
    p_up.add_argument("--release-dir", default=str(DEFAULT_RELEASE_DIR))
    p_up.add_argument("--visibility", choices=["public", "private"], default="public")
    p_up.add_argument("--license", default="Other", help="ModelScope license identifier (default: Other)")
    p_up.add_argument("--chinese-name", default="pi-posttrain-loop CoT 训练集与对抗评测集")
    p_up.add_argument(
        "--description",
        default="CoT SFT training/validation set (11,858 turns) and physically isolated adversarial/trap evaluation suites (adv-main-v1, trap-main-v1).",
    )
    p_up.add_argument("--create", action="store_true", help="Create the ModelScope dataset repo if it does not exist")
    p_up.add_argument("--revision", default="master")
    p_up.add_argument("--commit-message", default="Upload CoT SFT (train/val) and frozen eval suites (adv-main-v1, trap-main-v1)")
    p_up.add_argument("--token", default=None, help="ModelScope Access Token (prefer MODELSCOPE_API_TOKEN env var)")
    p_up.add_argument("--dry-run", action="store_true", help="Verify package and print upload plan without network calls")
    p_up.set_defaults(func=cmd_upload)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
