"""Losslessly export native v3 edited transcripts, with provenance kept outside prose.

Python 3.12+, standard library only. The source checkout is strictly read-only.
Run from the workspace root; see --help for export and verification modes.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
from collections import Counter, defaultdict


REPOSITORY_URL = "https://github.com/chosenecho/weimingzi-data"
BVID = re.compile(r"BV[0-9A-Za-z]{10}\Z")
YOUTUBE_ID = re.compile(r"[0-9A-Za-z_-]{11}\Z")
RECORD_ID = re.compile(r"[a-z]-[0-9a-f]{24}\Z")


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def semantic_sequence(text: str) -> str:
    """Ignore only whitespace, leading BOM and the observed U+200B artifact."""
    return re.sub(r"\s", "", text.lstrip("\ufeff").replace("\u200b", ""))


def clean_text(text: str) -> tuple[str, dict]:
    if not isinstance(text, str) or not text.strip():
        raise ValueError("A transcript must have nonempty authoritative text")
    normalized = text.lstrip("\ufeff").replace("\u200b", "")
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")
    normalized = "\n".join(line.rstrip(" \t") for line in normalized.split("\n"))
    normalized = re.sub(r"\n{3,}", "\n\n", normalized).strip() + "\n"
    if not semantic_sequence(normalized):
        raise ValueError("A transcript must contain semantic content")
    if semantic_sequence(text) != semantic_sequence(normalized):
        raise ValueError("Cleaning changed non-whitespace semantic content")
    return normalized, {
        "source_characters": len(text),
        "output_characters": len(normalized),
        "removed_zero_width_spaces": text.count("\u200b"),
        "removed_leading_bom": len(text) - len(text.lstrip("\ufeff")),
        "format_changed": normalized != text,
    }


def heading_text(title: str) -> str:
    """Keep source wording while escaping Markdown syntax in a single-line heading."""
    if not isinstance(title, str) or not title.strip():
        raise ValueError("A native title is required")
    single_line = " ".join(title.splitlines()).strip()
    return re.sub(r"([\\`*_{}\[\]()#+.!<>|~-])", r"\\\1", single_line)


def title_prefix(item: dict, parent: dict, part: int | None) -> str:
    video_title = parent.get("title", item["title"])
    prefix = f"# {heading_text(video_title)}\n\n"
    if part is not None and item["title"].strip() != video_title.strip():
        prefix += f"## P{part:03}：{heading_text(item['title'])}\n\n"
    return prefix


def completeness_rank(document: dict) -> int:
    value = document.get("is_complete")
    return 2 if value is True else (0 if value is False else 1)


def choose_primary(documents: list[dict]) -> tuple[dict, str]:
    """No inference that unknown timestamps mean older, or that longer means better."""
    highest = max(map(completeness_rank, documents))
    eligible = {d["id"]: d for d in documents if completeness_rank(d) == highest}
    all_docs = {d["id"]: d for d in documents}
    superseded = set()
    for document in eligible.values():
        seen = {document["id"]}
        cursor = document
        while True:
            parents = [e["target_id"] for e in cursor.get("inputs", []) if e["role"] == "derived_from"]
            if len(parents) > 1:
                raise ValueError("Multiple derived_from inputs")
            if not parents or parents[0] not in all_docs:
                break
            parent = parents[0]
            if parent in seen:
                raise ValueError("Cyclic revision lineage")
            seen.add(parent)
            superseded.add(parent)
            cursor = all_docs[parent]
    leaves = [d for did, d in eligible.items() if did not in superseded]
    if not leaves:
        raise ValueError("No primary revision candidate")
    chosen = min(leaves, key=lambda d: d["id"])
    reason = "only_record" if len(documents) == 1 else "completeness_then_explicit_revision_then_record_id"
    return chosen, reason


def record_route(item: dict, items: dict[str, dict]) -> dict:
    """Use native identifiers and actual part numbers, never inferred title matches."""
    iid = item["id"]
    if not RECORD_ID.fullmatch(iid):
        raise ValueError(f"Invalid item ID: {iid}")
    if item["kind"] == "audio_recording":
        return {"category": "audio", "key": iid, "part": None,
                "primary_path": f"supplemental/audio/{iid}.md",
                "variant_dir": f"variants/audio/{iid}", "parent_id": None}
    if item["kind"] != "video_part":
        raise ValueError(f"Unexpected edited-transcript item kind: {item['kind']}")
    part = item.get("part_number")
    if type(part) is not int or part < 1:
        raise ValueError(f"Invalid native part_number for {iid}")
    parent = items[item["parent_id"]]
    if parent["kind"] != "video":
        raise ValueError(f"Non-video parent for {iid}")
    ids = item.get("identifiers", {})
    bv = ids.get("bilibili_bvid", [])
    if bv:
        if len(bv) != 1 or not BVID.fullmatch(bv[0]):
            raise ValueError(f"Ambiguous or invalid BV identifier: {iid}")
        key = bv[0]
        if parent.get("identifiers", {}).get("bilibili_bvid") != [key]:
            raise ValueError(f"Parent/part BV mismatch: {iid}")
        if ids.get("bilibili_part") != [f"{key}:P{part}"]:
            raise ValueError(f"Native bilibili_part mismatch: {iid}")
        category, base = "bilibili", f"by_bv/{key}"
    else:
        youtube_parts = ids.get("youtube_part", [])
        if len(youtube_parts) != 1:
            raise ValueError(f"Video part without a unique native platform ID: {iid}")
        key, suffix = youtube_parts[0].rsplit(":P", 1)
        if not YOUTUBE_ID.fullmatch(key) or suffix != str(part):
            raise ValueError(f"Invalid YouTube part identity: {iid}")
        if parent.get("identifiers", {}).get("youtube_video") != [key]:
            raise ValueError(f"Parent/part YouTube mismatch: {iid}")
        category, base = "youtube", f"supplemental/youtube/{key}"
    return {"category": category, "key": key, "part": part,
            "primary_path": f"{base}/P{part:03}.md",
            "variant_dir": f"variants/{category}/{key}/P{part:03}",
            "parent_id": parent["id"]}


def put(path: Path, content: bytes, verify_only: bool, previous: bytes | None = None) -> None:
    """Only update a file when an explicit migration supplies its verified old bytes."""
    if path.exists():
        current = path.read_bytes()
        if current == content:
            return
        if verify_only or previous is None or current != previous:
            raise ValueError(f"Existing file differs from expected export: {path}")
        path.write_bytes(content)
        return
    if verify_only:
        raise ValueError(f"Expected exported file is missing: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def csv_bytes(rows: list[dict], columns: list[str]) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows({key: row.get(key) for key in columns} for row in rows)
    return ("\ufeff" + stream.getvalue()).encode("utf-8")


def export(source: Path, destination: Path, verify_only: bool = False, upgrade_titles: bool = False) -> dict:
    source, destination = source.resolve(), destination.resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Source and export directories must be disjoint")
    sys.path.insert(0, str(source / "src"))
    from weimingzi_corpus.records import iter_records, input_ids

    commit = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"],
                            check=True, capture_output=True, text=True).stdout.strip()
    dirty_data = subprocess.run(["git", "-C", str(source), "status", "--porcelain", "--", "data", "src"],
                               check=True, capture_output=True, text=True).stdout
    if dirty_data:
        raise ValueError("Source data or reading interface has uncommitted modifications")
    items = {d["id"]: d for d, _ in iter_records(source, "items")}
    groups = defaultdict(list)
    paths = {}
    for document, path in iter_records(source, "documents", kind="edited_transcript"):
        did = document["id"]
        if did in paths or not RECORD_ID.fullmatch(did):
            raise ValueError(f"Duplicate or invalid document ID: {did}")
        references = input_ids(document, "item")
        if len(references) != 1:
            raise ValueError(f"Expected exactly one item input: {did}")
        if not isinstance(document.get("text"), str):
            raise ValueError(f"Missing authoritative text: {did}")
        groups[references[0]].append(document)
        paths[did] = path
    if not groups:
        raise ValueError("No edited transcripts found")

    manifest, index, missing, ambiguous, incomplete = [], [], [], [], []
    expected, plain_bodies, routes, counts, clean_totals = {}, {}, {}, Counter(), Counter()
    for iid, documents in sorted(groups.items()):
        item = items[iid]
        route = record_route(item, items)
        main = route["primary_path"]
        if main in routes:
            raise ValueError(f"Two distinct native items route to {main}")
        routes[main] = iid
        selected, reason = choose_primary(documents)
        parent = items.get(route["parent_id"], {})
        row = {"category": route["category"], "platform_id": route["key"],
               "part_number": route["part"], "video_title": parent.get("title", item["title"]),
               "part_title": item["title"], "item_id": iid, "selected_document_id": selected["id"],
               "is_complete": selected.get("is_complete"), "version_count": len(documents),
               "primary_path": main, "source_url": (item.get("urls") or [""])[0]}
        index.append(row)
        counts[f"{route['category']}_primary_parts"] += 1
        if len(documents) > 1:
            ambiguous.append({**row, "document_ids": sorted(d["id"] for d in documents),
                              "selection_rule": reason})
        for document in sorted(documents, key=lambda d: d["id"]):
            did = document["id"]
            cleaned, changes = clean_text(document["text"])
            primary = did == selected["id"]
            relative = main if primary else f"{route['variant_dir']}/{did}.md"
            prefix = title_prefix(item, parent, route["part"])
            payload = (prefix + cleaned).encode("utf-8")
            plain_bodies[relative] = cleaned.encode("utf-8")
            if relative in expected:
                raise ValueError(f"Duplicate output path: {relative}")
            expected[relative] = payload
            entry = {"document_id": did, "item_id": iid, "category": route["category"],
                     "platform_id": route["key"], "part_number": route["part"],
                     "output_path": relative, "is_primary": primary,
                     "selection_rule": reason, "is_complete": document.get("is_complete"),
                     "quality": document.get("quality"), "model": document.get("model"),
                     "derived_from": input_ids(document, "derived_from"),
                     "generated_at_unix_seconds": document.get("metadata", {}).get("generated_at_unix_seconds"),
                     "source_json": paths[did].relative_to(source).as_posix(),
                     "source_json_sha256": sha256(paths[did].read_bytes()),
                     "source_text_sha256": sha256(document["text"].encode("utf-8")),
                     "output_sha256": sha256(payload), "output_bytes": len(payload),
                     "body_sha256": sha256(cleaned.encode("utf-8")),
                     "video_title": row["video_title"], "part_title": item["title"],
                     "title_prefix": prefix, "cleaning": changes}
            manifest.append(entry)
            counts[f"{route['category']}_source_documents"] += 1
            counts["primary_documents" if primary else "alternative_documents"] += 1
            counts["output_bytes"] += len(payload)
            clean_totals["removed_zero_width_spaces"] += changes["removed_zero_width_spaces"]
            clean_totals["removed_leading_bom"] += changes["removed_leading_bom"]
            clean_totals["format_changed_documents"] += int(changes["format_changed"])
            if document.get("is_complete") is not True:
                incomplete.append({k: entry[k] for k in ("document_id", "output_path", "is_primary", "is_complete", "category")})
    for iid, item in sorted(items.items()):
        if item["kind"] == "video_part" and iid not in groups:
            route = record_route(item, items)
            missing.append({"item_id": iid, "category": route["category"], "platform_id": route["key"],
                            "part_number": route["part"], "title": item["title"],
                            "reason": "no_native_edited_transcript; raw transcripts are not substituted"})

    counts["edited_transcripts"] = len(manifest)
    counts["bilibili_videos"] = len({r["platform_id"] for r in index if r["category"] == "bilibili"})
    counts["youtube_videos"] = len({r["platform_id"] for r in index if r["category"] == "youtube"})
    counts["multipart_bilibili_videos"] = sum(n > 1 for n in Counter(r["platform_id"] for r in index if r["category"] == "bilibili").values())
    counts["multiple_version_items"] = len(ambiguous)
    counts["incomplete_source_documents"] = sum(r["is_complete"] is False for r in incomplete)
    counts["incomplete_primary_documents"] = sum(r["is_complete"] is False and r["is_primary"] for r in incomplete)
    counts["video_parts_without_edited_transcript"] = len(missing)
    manifest.sort(key=lambda x: x["document_id"])
    index.sort(key=lambda x: (x["category"], x["platform_id"], x["part_number"] or 0))
    report = {"source_repository": REPOSITORY_URL, "source_commit": commit,
              "source_schema": 3, "export_schema": 2, "counts": dict(counts),
              "title_rule": "H1 native video title; H2 Pxxx and native part title when different; audio uses its own native title", 
              "source_items_sha256": sha256((source / "data/items.jsonl").read_bytes()),
              "cleaning": dict(clean_totals),
              "validation": {"every_edited_transcript_exported_once": len(manifest) == len(paths) == len(expected),
                             "every_semantic_sequence_preserved": True,
                             "every_document_has_native_title": True,
                             "unique_primary_path_per_item": len(routes) == len(groups),
                             "source_data_unmodified": True},
              "selection_rule": "complete(true > unknown > false), then exclude explicit revision ancestors at the same completeness rank, then ascending record ID; not a quality/latest-version claim",
              "incomplete_documents": incomplete, "multiple_version_items": ambiguous,
              "parts_without_edited_transcript": missing,
              "scope_note": "Native titles plus edited_transcript.text only. No ASR/transcript fallback, inferred BV mapping, summaries, or rewriting. Source quality remains unchanged."}
    if not all(report["validation"].values()):
        raise ValueError("Export completeness validation failed")
    parts_by_video = defaultdict(list)
    for item in items.values():
        if item["kind"] == "video_part":
            parts_by_video[item["parent_id"]].append(item)
    video_coverage = []
    for iid, item in sorted(items.items()):
        if item["kind"] != "video":
            continue
        ids = item.get("identifiers", {})
        platform = "bilibili" if ids.get("bilibili_bvid") else "youtube"
        platform_id = (ids.get("bilibili_bvid") or ids.get("youtube_video") or [iid])[0]
        video_parts = parts_by_video[iid]
        covered = [p for p in video_parts if p["id"] in groups]
        video_coverage.append({"category": platform, "platform_id": platform_id, "video_title": item["title"],
                               "item_id": iid, "native_part_count": len(video_parts),
                               "parts_with_edited_transcripts": len(covered),
                               "source_document_count": sum(len(groups[p["id"]]) for p in covered),
                               "coverage": "no_native_parts" if not video_parts else (
                                   "no_edited_transcripts" if not covered else (
                                       "partial" if len(covered) < len(video_parts) else "all_native_parts"))})
    coverage_summary = {"source_commit": commit, "native_videos": len(video_coverage),
                        "bilibili_videos": sum(r["category"] == "bilibili" for r in video_coverage),
                        "bilibili_videos_without_edited_transcripts": sum(r["category"] == "bilibili" and r["parts_with_edited_transcripts"] == 0 for r in video_coverage),
                        "bilibili_videos_without_native_parts": sum(r["category"] == "bilibili" and r["native_part_count"] == 0 for r in video_coverage),
                        "bilibili_parts_without_edited_transcripts": sum(r["category"] == "bilibili" for r in missing),
                        "youtube_parts_without_edited_transcripts": sum(r["category"] == "youtube" for r in missing),
                        "note": "Metadata-only videos are not exported as invented or empty Markdown; coverage is limited to native archive records."}
    metadata = {
        "_meta/coverage-report.json": json_bytes(coverage_summary),
        "_meta/video-coverage.csv": csv_bytes(video_coverage, ["category", "platform_id", "video_title", "item_id", "native_part_count", "parts_with_edited_transcripts", "source_document_count", "coverage"]),
        "_meta/report.json": json_bytes(report),
        "_meta/manifest.jsonl": ("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in manifest)).encode("utf-8"),
        "_meta/index.csv": csv_bytes(index, ["category", "platform_id", "part_number", "video_title", "part_title", "item_id", "selected_document_id", "is_complete", "version_count", "primary_path", "source_url"]),
        "_meta/missing-edited-transcripts.csv": csv_bytes(missing, ["item_id", "category", "platform_id", "part_number", "title", "reason"]),
        "_meta/SHA256SUMS": ("".join(f"{sha256(content)}  {relative}\n" for relative, content in sorted(expected.items()))).encode("utf-8"),
    }
    previous = {}
    if upgrade_titles:
        if verify_only:
            raise ValueError("Title migration and verify-only are separate operations")
        old_report = json.loads((destination / "_meta/report.json").read_text(encoding="utf-8"))
        old_manifest = [json.loads(line) for line in (destination / "_meta/manifest.jsonl").read_text(encoding="utf-8").splitlines()]
        if old_report["source_commit"] != commit or old_report["export_schema"] != 1:
            raise ValueError("Title migration requires a matching prose-only v1 export")
        if {r["document_id"] for r in old_manifest} != set(paths) or len(old_manifest) != len(manifest):
            raise ValueError("Title migration source set differs")
        for row in old_manifest:
            relative = row["output_path"]
            current = (destination / relative).read_bytes()
            if relative not in plain_bodies or current != plain_bodies[relative] or sha256(current) != row["output_sha256"]:
                raise ValueError(f"Title migration found edited or unknown prose: {relative}")
            if sha256(paths[row["document_id"]].read_bytes()) != row["source_json_sha256"]:
                raise ValueError("Title migration source JSON differs")
            previous[relative] = current
        # Retain the old provenance verbatim; all old bodies are reproducible from source.
        for relative in metadata:
            path = destination / relative
            if path.exists():
                previous[relative] = path.read_bytes()
                put(destination / "_meta/history/prose-only-v1" / path.name, previous[relative], False)
    for relative, content in {**expected, **metadata}.items():
        put(destination / relative, content, verify_only, previous.get(relative))
    actual_markdown = {p.relative_to(destination).as_posix() for sub in ("by_bv", "supplemental", "variants")
                       for p in (destination / sub).rglob("*.md")}
    if actual_markdown != set(expected):
        raise ValueError(f"Output set mismatch: extra={sorted(actual_markdown-set(expected))}, missing={sorted(set(expected)-actual_markdown)}")
    print(json.dumps({"mode": "verified" if verify_only else "exported", "destination": str(destination),
                      "source_commit": commit, "counts": dict(counts), "cleaning": dict(clean_totals),
                      "validation": report["validation"]}, ensure_ascii=False, indent=2))
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("data/weimingzi-source"))
    parser.add_argument("--destination", type=Path, default=Path("data/weimingzi-semantic"))
    parser.add_argument("--verify-only", action="store_true", help="Recompute and compare every document/metadata byte without writing")
    parser.add_argument("--upgrade-titles", action="store_true", help="Migrate a matching unmodified prose-only v1 export, retaining old provenance")
    args = parser.parse_args()
    export(args.source, args.destination, args.verify_only, args.upgrade_titles)


if __name__ == "__main__":
    main()
