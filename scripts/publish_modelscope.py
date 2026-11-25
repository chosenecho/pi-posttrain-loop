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
import stat
import sys
import tempfile
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable

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

RELEASE_FILES = (
    "README.md",
    "data/cot_sft/train.jsonl",
    "data/cot_sft/val.jsonl",
    "data/eval/adv-main-v1.jsonl",
    "data/eval/trap-main-v1.jsonl",
    "manifests/cot-sft-manifest.json",
    "manifests/adv-main-v1.manifest.json",
    "manifests/trap-main-v1.manifest.json",
    "manifests/SHA256SUMS.txt",
)
CHECKSUM_FILES = RELEASE_FILES[1:8]
CACHE_NAME = ".ms_upload_cache"
REVIEWABLE = frozenset({"email", "cn_mobile", "cn_id"})
ABS_PATH_LEAK_RE = re.compile(
    r"(?:\b[A-Za-z]:[\\/]|/(?:Users|home)/|\\\\[A-Za-z0-9_.-]+\\)", re.IGNORECASE
)
SECRET_PATTERNS = (
    ("private_key", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----")),
    ("credential", re.compile(
        r"\b(?:sk-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}"
        r"|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|LTAI[A-Za-z0-9]{12,}"
        r"|AIza[A-Za-z0-9_-]{30,}|hf_[A-Za-z0-9]{25,}|xox[baprs]-[A-Za-z0-9-]{20,})\b")),
    ("credential", re.compile(r"\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b")),
    ("credential", re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@")),
    ("credential", re.compile(
        r"(?i)(?:api[_-]?key|access[_-]?token|secret|passw[o]rd|authorization)\s*[\"']?\s*[:=]\s*"
        r"[\"']?(?:Bearer\s+)?[A-Za-z0-9_+./=-]{12,}")),
)
EMAIL_RE = re.compile(r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9])")
MOBILE_RE = re.compile(r"(?<![A-Za-z0-9])(?:\+86[ -]?)?1[3-9]\d{9}(?![A-Za-z0-9])")
ID_RE = re.compile(r"(?<![A-Za-z0-9])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?![A-Za-z0-9])")
PUBLIC_FIELDS = frozenset({
    "messages", "role", "content", "difficulty", "expectedBehavior", "itemKey", "persona", "probeType",
    "rubrics", "videoKey", "outSha256", "valSha256", "sha256", "sourceFiles", "train", "validation",
    "packagedPath", "description", "source", "path", "metadata", "model", "baseUrl", "apiKey", "email",
})


class ReleaseValidationError(ValueError):
    """A diagnostic containing only trusted labels, never source values or host paths."""


def fail(label: str, category: str, line: int = 1, field: str = "$") -> None:
    raise ReleaseValidationError(f"{label}: line={line} field={field} type={category}")


def is_link(path: Path) -> bool:
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def check_path_components(path: Path) -> None:
    """Check lexical components before resolve() can hide links or junctions."""
    absolute = path.absolute()
    for component in reversed((absolute, *absolute.parents)):
        if component.exists() or component.is_symlink():
            if is_link(component):
                fail("release", "linked_path")


def release_inventory(root: Path, *, require_complete: bool = True) -> list[Path]:
    check_path_components(root)
    if not root.is_dir():
        if require_complete:
            fail("release", "missing_directory")
        return []
    allowed_dirs = {str(Path(f).parent).replace("\\", "/") for f in RELEASE_FILES}
    allowed_dirs |= {"data", "manifests", "data/cot_sft", "data/eval"}
    found: set[str] = set()
    for directory, dirs, files in os.walk(root, followlinks=False):
        parent = Path(directory)
        for name in [*dirs, *files]:
            candidate = parent / name
            rel = candidate.relative_to(root).as_posix()
            if is_link(candidate):
                fail("release", "linked_entry")
            if candidate.resolve().is_relative_to(root.resolve()) is False:
                fail("release", "outside_reference")
            if rel == CACHE_NAME or rel.startswith(CACHE_NAME + "/"):
                if not candidate.is_dir() and not stat.S_ISREG(candidate.stat().st_mode):
                    fail("release", "invalid_cache")
            elif candidate.is_dir():
                if rel not in allowed_dirs:
                    fail("release", "unexpected_directory")
            elif rel in RELEASE_FILES and stat.S_ISREG(candidate.stat().st_mode):
                if candidate.stat().st_nlink != 1:
                    fail(rel, "hard_link")
                found.add(rel)
            else:
                # An unexpected filename may itself contain a secret.
                fail("release", "unexpected_file")
    if require_complete:
        for rel in RELEASE_FILES:
            if rel not in found:
                fail(rel, "missing_file")
    return [root / rel for rel in RELEASE_FILES if rel in found]


def configured_secrets(args: argparse.Namespace) -> tuple[str, ...]:
    names = ("LLM_API_KEY", "REASONING_API_KEY", "REASONING_JUDGE_API_KEY", "EVAL_LLM_API_KEY",
             "CANDIDATE_LLM_API_KEY", "MODELSCOPE_API_TOKEN")
    values = [os.environ.get(name, "") for name in names]
    values.append(getattr(args, "token", None) or "")
    return tuple(value.strip() for value in values
                 if value.strip() and value.strip() not in {"EMPTY", "replace-with-your-key"})


def value_fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_reviews(review_path: str | None, root: Path) -> set[tuple[str, int, str, str, str]]:
    if not review_path:
        return set()
    path = Path(review_path)
    try:
        check_path_components(path)
        if path.resolve().is_relative_to(root.resolve()):
            fail("review", "review_must_be_outside_release")
        obj = parse_json(path.read_text(encoding="utf-8"), "review")
        if not isinstance(obj, dict) or set(obj) != {"version", "approvals"} or obj["version"] != 1:
            fail("review", "invalid_format")
        if not isinstance(obj["approvals"], list):
            fail("review", "invalid_format")
        result = set()
        for item in obj["approvals"]:
            if not isinstance(item, dict) or set(item) != {"file", "line", "field", "category", "sha256", "reason"}:
                fail("review", "invalid_approval")
            if (item["file"] not in RELEASE_FILES or type(item["line"]) is not int or item["line"] < 1
                    or not isinstance(item["field"], str) or not item["field"].startswith("$")
                    or item["category"] not in REVIEWABLE
                    or not isinstance(item["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"])
                    or not isinstance(item["reason"], str) or len(item["reason"].strip()) < 8):
                fail("review", "invalid_approval")
            result.add((item["file"], item["line"], item["field"], item["category"], item["sha256"]))
        return result
    except ReleaseValidationError:
        raise
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        fail("review", "invalid_format")


def valid_cn_id(value: str) -> bool:
    import datetime
    try:
        datetime.datetime.strptime(value[6:14], "%Y%m%d")
    except ValueError:
        return False
    weights = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
    return "10X98765432"[sum(int(n) * w for n, w in zip(value[:17], weights)) % 11] == value[-1].upper()


def scan_string(value: str, label: str, line: int, field: str, reviews: set,
                secrets: Iterable[str], *, paths: bool = True) -> None:
    categories = {category for category, pattern in SECRET_PATTERNS if pattern.search(value)}
    if any(secret in value for secret in secrets):
        categories.add("configured_secret")
    if paths and ABS_PATH_LEAK_RE.search(value):
        categories.add("absolute_path")
    if EMAIL_RE.search(value):
        categories.add("email")
    if MOBILE_RE.search(value):
        categories.add("cn_mobile")
    if any(valid_cn_id(m.group()) for m in ID_RE.finditer(value)):
        categories.add("cn_id")
    for category in sorted(categories):
        approval = (label, line, field, category, value_fingerprint(value))
        if category not in REVIEWABLE or approval not in reviews:
            fail(label, category, line, field)


def scan_value(value: Any, label: str, line: int, field: str, reviews: set,
               secrets: Iterable[str], *, paths: bool = True, depth: int = 0) -> None:
    if depth > 64:
        fail(label, "nesting_limit", line)
    if isinstance(value, str):
        scan_string(value, label, line, field, reviews, secrets, paths=paths)
    elif isinstance(value, int) and not isinstance(value, bool):
        scan_string(str(value), label, line, field, reviews, secrets, paths=paths)
    elif isinstance(value, float) and value.is_integer():
        # JSON integer-valued literals are parsed exactly below. This branch also
        # covers finite integral floats passed by in-process callers.
        scan_string(str(int(value)), label, line, field, reviews, secrets, paths=paths)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            scan_value(child, label, line, f"{field}[{index}]", reviews, secrets, paths=paths, depth=depth + 1)
    elif isinstance(value, dict):
        for index, (key, child) in enumerate(value.items()):
            # Scan keys too, but never echo arbitrary keys in diagnostic field paths.
            scan_string(key, label, line, f"{field}[key:{index}]", reviews, secrets, paths=paths)
            if (re.fullmatch(r"(?i)(?:.*api.?key|access.?token|refresh.?token|token|(?:client.?)?secret|passw[o]rd|authorization|cookie)", key)
                    and child is not None and not isinstance(child, bool)):
                present = (bool(child.strip()) and child.strip() not in {"EMPTY", "replace-with-your-key"}
                           if isinstance(child, str) else isinstance(child, (int, float)) or bool(child))
                if present:
                    fail(label, "credential_field", line, f"{field}[value:{index}]")
            safe_key = key if key in PUBLIC_FIELDS else "key:" + value_fingerprint(key)[:12]
            scan_value(child, label, line, f"{field}.{safe_key}", reviews, secrets, paths=paths, depth=depth + 1)


def parse_json(text: str, label: str, line: int = 1) -> Any:
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail(label, "duplicate_json_key", line)
            result[key] = value
        return result
    def exact_number(raw):
        # Preserve numeric identities written as 110...010.0 or 1.10...e17;
        # decoding through binary float first would lose their check digit.
        number = Decimal(raw)
        if number == number.to_integral_value():
            if number and number.adjusted() >= 1024:
                fail(label, "number_limit", line)
            return int(number)
        return float(raw)
    try:
        return json.loads(text, object_pairs_hook=unique_object, parse_float=exact_number)
    except ReleaseValidationError:
        raise
    except (ValueError, RecursionError):
        fail(label, "invalid_json", line)


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = parse_json(path.read_text(encoding="utf-8"), label)
        if not isinstance(value, dict):
            fail(label, "invalid_json_object")
        return value
    except ReleaseValidationError:
        raise
    except (OSError, ValueError, RecursionError):
        fail(label, "invalid_json")


def validate_release(root: Path, *, review_path: str | None = None,
                     secrets: Iterable[str] = ()) -> list[Path]:
    """Shared prepare/upload gate. Reads only; all diagnostics use fixed file labels."""
    try:
        files = release_inventory(root)
        reviews = load_reviews(review_path, root)
        for path in files:
            label = path.relative_to(root).as_posix()
            if path.suffix == ".json":
                scan_value(read_json(path, label), label, 1, "$", reviews, secrets)
            elif path.suffix == ".jsonl":
                with path.open("r", encoding="utf-8") as stream:
                    for line, text in enumerate(stream, 1):
                        value = parse_json(text, label, line)
                        scan_value(value, label, line, "$", reviews, secrets)
                validate_jsonl(path, expected_keys=EXPECTED_COT_KEYS if "cot_sft/" in label else EXPECTED_EVAL_KEYS,
                               require_think="cot_sft/" in label, label=label)
            else:
                for line, text in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                    scan_string(text, label, line, "$", reviews, secrets)

        manifests = [("manifests/cot-sft-manifest.json", "outSha256", "data/cot_sft/train.jsonl"),
                     ("manifests/cot-sft-manifest.json", "valSha256", "data/cot_sft/val.jsonl"),
                     ("manifests/adv-main-v1.manifest.json", "sha256", "data/eval/adv-main-v1.jsonl"),
                     ("manifests/trap-main-v1.manifest.json", "sha256", "data/eval/trap-main-v1.jsonl")]
        for manifest, key, data in manifests:
            expected = read_json(root / manifest, manifest).get(key)
            if expected != sha256_file(root / data):
                fail(manifest, "manifest_checksum", field=f"$.{key}")
        sums: dict[str, str] = {}
        for line in (root / RELEASE_FILES[-1]).read_text(encoding="utf-8").splitlines():
            match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
            if not match or match[2] not in CHECKSUM_FILES or match[2] in sums:
                fail(RELEASE_FILES[-1], "invalid_checksums")
            sums[match[2]] = match[1]
        if set(sums) != set(CHECKSUM_FILES):
            fail(RELEASE_FILES[-1], "incomplete_checksums")
        for label, expected in sums.items():
            if sha256_file(root / label) != expected:
                fail(label, "checksum_mismatch")
        return files
    except ReleaseValidationError:
        raise
    except (OSError, UnicodeError, ValueError, TypeError, RecursionError):
        fail("release", "unreadable_or_invalid_content")


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
    label: str = "source.jsonl",
) -> dict[str, Any]:
    line_count = 0
    turn_dist: dict[int, int] = {}
    asst_lens: list[int] = []
    try:
        with path.open("r", encoding="utf-8") as f:
            for line_no, raw_line in enumerate(f, start=1):
                if not raw_line.strip():
                    fail(label, "empty_line", line_no)
                obj = parse_json(raw_line, label, line_no)
                if not isinstance(obj, dict) or tuple(sorted(obj)) != expected_keys:
                    fail(label, "schema_mismatch", line_no)
                messages = obj.get("messages")
                if not isinstance(messages, list) or len(messages) < 2:
                    fail(label, "invalid_messages", line_no)
                for message in messages:
                    if (not isinstance(message, dict) or message.get("role") not in {"system", "user", "assistant"}
                            or not isinstance(message.get("content"), str)):
                        fail(label, "invalid_message", line_no)
                if messages[-1]["role"] != "assistant":
                    fail(label, "invalid_last_message", line_no)
                content = messages[-1]["content"]
                if require_think and ("<think>" not in content or "</think>" not in content):
                    fail(label, "missing_think", line_no)
                line_count += 1
                turn_dist[len(messages)] = turn_dist.get(len(messages), 0) + 1
                asst_lens.append(len(content))
        if not line_count:
            fail(label, "empty_file")
        asst_lens.sort()
        return {
            "lines": line_count, "bytes": path.stat().st_size, "sha256": sha256_file(path),
            "msg_len_dist": dict(sorted(turn_dist.items())),
            "last_asst_chars": {"min": asst_lens[0], "p50": asst_lens[len(asst_lens) // 2],
                               "p95": asst_lens[int(len(asst_lens) * 0.95)], "max": asst_lens[-1]},
        }
    except ReleaseValidationError:
        raise
    except (OSError, UnicodeError):
        fail(label, "unreadable_content")


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
    release_dir = Path(args.release_dir).absolute()
    release_inventory(release_dir, require_complete=False)
    secrets = configured_secrets(args)
    reviews = load_reviews(getattr(args, "privacy_review", None), release_dir)
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

    cot_manifest_raw = read_json(sources["cot_manifest"], "manifests/cot-sft-manifest.json")
    adv_manifest_raw = read_json(sources["eval_adv_manifest"], "manifests/adv-main-v1.manifest.json")
    trap_manifest_raw = read_json(sources["eval_trap_manifest"], "manifests/trap-main-v1.manifest.json")
    # Path normalization is limited to metadata. Secrets/PII must never disappear through it.
    for label, payload in (("manifests/cot-sft-manifest.json", cot_manifest_raw),
                           ("manifests/adv-main-v1.manifest.json", adv_manifest_raw),
                           ("manifests/trap-main-v1.manifest.json", trap_manifest_raw)):
        scan_value(payload, label, 1, "$", reviews, secrets, paths=False)

    # Verify SHA-256 matches source manifests
    checks = [
        ("cot_train", stats["cot_train"]["sha256"], cot_manifest_raw.get("outSha256")),
        ("cot_val", stats["cot_val"]["sha256"], cot_manifest_raw.get("valSha256")),
        ("eval_adv", stats["eval_adv"]["sha256"], adv_manifest_raw.get("sha256")),
        ("eval_trap", stats["eval_trap"]["sha256"], trap_manifest_raw.get("sha256")),
    ]
    for label, actual_sha, expected_sha in checks:
        if actual_sha != expected_sha:
            fail("source-manifest", "checksum_mismatch")
    print("  All 4 JSONL files passed schema, <think>, and manifest SHA-256 checks.")

    print("[2/5] Assembling release directory...")
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
        print(f"  Copied {dst.relative_to(release_dir).as_posix()} ({format_size(dst.stat().st_size)})")

    print("[3/5] Sanitizing and writing manifests...")
    replacements = {
        str(sources["cot_train"]).replace("\\", "/"): "data/cot_sft/train.jsonl",
        str(sources["cot_val"]).replace("\\", "/"): "data/cot_sft/val.jsonl",
        str(REPO_ROOT / "data" / "data-maker.sqlite").replace("\\", "/"): "data/data-maker.sqlite",
    }

    cot_manifest = sanitize_value(cot_manifest_raw, replacements)
    cot_manifest["sourceFiles"] = {
        "train": "data/cot_sft/train.jsonl",
        "validation": "data/cot_sft/val.jsonl",
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
    files = validate_release(release_dir, review_path=getattr(args, "privacy_review", None), secrets=secrets)
    total_bytes = sum(p.stat().st_size for p in files)
    print("Release package ready.")
    print(f"Total size: {format_size(total_bytes)}")
    return 0


def cmd_upload(args: argparse.Namespace) -> int:
    release_dir = Path(args.release_dir).absolute()
    secrets = configured_secrets(args)
    review_path = getattr(args, "privacy_review", None)
    files = validate_release(release_dir, review_path=review_path, secrets=secrets)
    repo_id = args.repo_id.strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo_id):
        fail("upload", "invalid_repository_id")
    for key in ("repo_id", "license", "chinese_name", "description", "commit_message", "revision"):
        scan_string(str(getattr(args, key, "")), "upload", 1, "$", set(), secrets)

    print("=== ModelScope Upload Plan ===")
    print(f"  Files ({len(files)}, total {format_size(sum(p.stat().st_size for p in files))}):")
    for path in files:
        print(f"    - {path.relative_to(release_dir).as_posix()}")
    if args.dry_run:
        print("[dry-run] Validation passed. No network requests or release writes were made.")
        return 0

    # The SDK receives only a private copy of the nine validated files. Its recursive
    # traversal can never reach source-directory extras, links, or the local cache.
    with tempfile.TemporaryDirectory(prefix="modelscope-release-") as temporary:
        snapshot = Path(temporary) / "release"
        for rel in RELEASE_FILES:
            destination = snapshot / rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((release_dir / rel).read_bytes())
        readme = snapshot / "README.md"
        text = readme.read_text(encoding="utf-8")
        readme.write_text(text.replace("<your-namespace>/<dataset-name>", repo_id), encoding="utf-8")
        validate_release(snapshot, review_path=review_path, secrets=secrets)

        token = args.token or os.environ.get("MODELSCOPE_API_TOKEN")
        from modelscope_hub.api import HubApi
        from modelscope_hub.errors import AlreadyExistsError

        api = HubApi(token=token)
        if not token and not api._config.token:
            fail("upload", "missing_token")
        if args.create:
            try:
                api.create_repo(repo_id=repo_id, repo_type="dataset", visibility=args.visibility,
                                license=args.license, chinese_name=args.chinese_name, description=args.description)
            except AlreadyExistsError:
                pass
        api.upload_folder(
            repo_id=repo_id, repo_type="dataset", folder_path=snapshot,
            commit_message=args.commit_message, revision=args.revision,
            ignore_patterns=[CACHE_NAME, CACHE_NAME + "/*", CACHE_NAME + "/**"],
        )
    print("Upload complete.")
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
    p_prep.add_argument("--privacy-review", help="External JSON v1 approvals: file/line/field/category/sha256/reason; PII only")
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
    p_up.add_argument("--privacy-review", help="External JSON v1 approvals: file/line/field/category/sha256/reason; PII only")
    p_up.set_defaults(func=cmd_upload)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.func(args)
    except ReleaseValidationError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception:
        # Parser/OS/SDK exception messages may contain response bodies, paths or keys.
        print("publish: type=operation_failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
