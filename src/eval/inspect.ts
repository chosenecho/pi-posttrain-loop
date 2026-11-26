import { createSeededRng, shuffleInPlace } from "../shared/utils.js";
import type { EvalStore, ProbeRecord } from "./store/index.js";

/**
 * Deterministic stratified sampling across probe types (round-robin after per-bucket shuffle).
 */
export function stratifiedSampleProbes(
  probes: readonly ProbeRecord[],
  sampleSize: number,
  seed: number,
): ProbeRecord[] {
  if (probes.length <= sampleSize) return [...probes];
  const rng = createSeededRng(seed);
  const byType = new Map<string, ProbeRecord[]>();
  for (const p of probes) {
    const list = byType.get(p.probeType);
    if (list) list.push(p);
    else byType.set(p.probeType, [p]);
  }
  const buckets = [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, list] of buckets) {
    shuffleInPlace(list, rng);
  }
  const picked: ProbeRecord[] = [];
  let cursor = 0;
  while (picked.length < sampleSize) {
    let added = false;
    for (const [, list] of buckets) {
      if (cursor < list.length && picked.length < sampleSize) {
        picked.push(list[cursor]!);
        added = true;
      }
    }
    if (!added) break;
    cursor++;
  }
  return picked;
}

/**
 * Renders a human-reviewable Markdown inspection report for selected probes,
 * including anchors, critic reviews, multi-turn dialogues, rubrics, and calibration scores.
 */
export function renderInspectMarkdown(
  store: EvalStore,
  runId: number | undefined,
  probes: readonly ProbeRecord[],
  totalMatched: number,
): string {
  const lines: string[] = [];
  lines.push("# 评测考题（Probe）抽检报告");
  lines.push("");
  if (runId !== undefined) {
    const run = store.getRun(runId);
    lines.push(`- **Run ID**: \`${runId}\`（状态：\`${run?.status ?? "unknown"}\`，模型：\`${String(run?.config?.modelId ?? "unknown")}\`）`);
  }
  lines.push(`- **匹配考题数**: ${totalMatched}　｜　**本报告展示**: ${probes.length}`);

  const typeDist: Record<string, number> = {};
  const statusDist: Record<string, number> = {};
  for (const p of probes) {
    typeDist[p.probeType] = (typeDist[p.probeType] ?? 0) + 1;
    statusDist[p.status] = (statusDist[p.status] ?? 0) + 1;
  }
  lines.push(`- **题型分布**: ${Object.entries(typeDist).map(([k, v]) => `\`${k}\`=${v}`).join("、")}`);
  lines.push(`- **状态分布**: ${Object.entries(statusDist).map(([k, v]) => `\`${k}\`=${v}`).join("、")}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (let i = 0; i < probes.length; i++) {
    const p = probes[i]!;
    const source = store.getSourceMaterial(p.sourceMaterialId);
    const turns = store.listProbeTurns(p.id);
    const calibrations = store.listCalibrationsForProbe(p.id);

    const diffLabel = p.difficulty ?? "未标定";
    lines.push(`## #${i + 1} · Probe ${p.id}（\`${p.probeType}\` / ${p.persona} / ${p.targetTurns} 轮 / 难度：\`${diffLabel}\`）`);
    lines.push("");
    lines.push(`- **视频**: \`${source?.videoId ?? p.sourceMaterialId}\`（slot ${p.slotIndex}，run ${p.runId}）`);
    lines.push(`- **状态**: \`${p.status}\`　｜　**锚点校验**: ${p.anchorVerified ? "通过" : "未命中"}　｜　**审题改写次数**: ${p.revisions}`);
    if (p.rejectReason) {
      lines.push(`- **拒绝/放弃原因**: ${p.rejectReason}`);
    }
    lines.push("");
    lines.push(`**首轮考题**：${p.question}`);
    lines.push("");
    lines.push(`> **原稿锚点**：${p.anchor}`);
    lines.push("");
    lines.push(`**陷阱预期（trap）**：${p.trap}`);
    lines.push("");

    if (p.reviews.length > 0) {
      lines.push("**审题记录（probe-critic）**：");
      for (const r of p.reviews) {
        const detail = r.decision === "accept"
          ? "accept"
          : `${r.decision} — ${r.feedback || r.issues.join("; ")}`;
        lines.push(`- Round ${r.roundNo}: \`${detail}\``);
      }
      lines.push("");
    }

    for (const turn of turns) {
      const tacticTag = turn.tactic ? ` · 手法 \`${turn.tactic}\`` : "";
      if (turn.turnNo > 1) {
        lines.push(`### Turn ${turn.turnNo}（\`${turn.expectedBehavior}\`${tacticTag}）`);
        lines.push("");
        lines.push(`**施压追问**：${turn.userContent}`);
        lines.push("");
      }
      lines.push(`**参考答案（Turn ${turn.turnNo}，核验 ${turn.attempts} 次）**：`);
      lines.push("");
      lines.push(turn.referenceAnswer);
      lines.push("");
      lines.push(`**评分卡（Turn ${turn.turnNo} rubric）**：`);
      lines.push("```json");
      lines.push(JSON.stringify(turn.rubric, null, 2));
      lines.push("```");
      lines.push("");

      const cal = calibrations.find((c) => c.turnNo === turn.turnNo);
      if (cal) {
        const rationale =
          typeof cal.detail?.judgement === "object" && cal.detail?.judgement !== null
            ? String((cal.detail.judgement as { rationale?: unknown }).rationale ?? "")
            : "";
        lines.push(`**难度标定（Turn ${turn.turnNo} 裸答得分 ${cal.score} / 100，behaviorOk=\`${cal.behaviorOk}\`）**：${rationale}`);
        lines.push("");
      }
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
