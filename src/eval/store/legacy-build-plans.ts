import type { DatabaseSync } from "node:sqlite";
import { parseJson } from "../../shared/schema.js";
import { nowIso } from "../../shared/utils.js";
import { probeBuildSpecHash } from "../probe-checkpoint.js";
import { EvalBuildPlanRepo } from "./build-plan-repo.js";
import { EvalProbeRepo } from "./probe-repo.js";
import { EvalSourceRepo } from "./source-repo.js";
import { ADVERSARY_TACTICS, PROBE_TYPES, type ProbeBuildCheckpoint, type ProbeBuildDraft, type ProbeBuildSpec, type ProbeRecord, type ProbeRunRecord } from "./types.js";

export interface LegacyBuildMigrationReport {
  createdPlans: number;
  incompletePlanIds: number[];
  conflictPlanIds: number[];
}
function legacySpec(run: ProbeRunRecord): ProbeBuildSpec | null {
  const promptKeys = ["probeWriter", "probeCritic", "reference", "verifier", "adversary"] as const;
  if (typeof run.config.modelId !== "string" || promptKeys.some(k => typeof run.prompts[k] !== "string" || !String(run.prompts[k]).trim())) return null;
  const allowedTypes = Array.isArray(run.config.allowedTypes) ? run.config.allowedTypes : [...PROBE_TYPES];
  if (!allowedTypes.length || allowedTypes.some(t => !PROBE_TYPES.includes(t))) return null;
  const maxProbesPerVideo = Number(run.config.maxProbesPerVideo);
  const maxRevisions = Number(run.config.maxRevisions);
  const maxAnswerAttempts = Number(run.config.maxAnswerAttempts);
  if (!Number.isSafeInteger(maxProbesPerVideo) || maxProbesPerVideo < 1 || !Number.isSafeInteger(maxRevisions) || maxRevisions < 0 || !Number.isSafeInteger(maxAnswerAttempts) || maxAnswerAttempts < 1) return null;
  const skills: ProbeBuildSpec["skills"] = [];
  for (const entry of run.skills) {
    if (!entry || typeof entry !== "object" || !("name" in entry) || !("status" in entry) || !("sha256" in entry)) return null;
    if (typeof entry.name !== "string" || typeof entry.status !== "string" || typeof entry.sha256 !== "string") return null;
    skills.push({ name: entry.name, status: entry.status, sha256: entry.sha256 });
  }
  return { version: 1, modelId: run.config.modelId, allowedTypes, maxProbesPerVideo, maxRevisions, maxAnswerAttempts, prompts: Object.fromEntries(promptKeys.map(k => [k, run.prompts[k]])) as ProbeBuildSpec["prompts"], skills };
}

/** Strict legacy evidence parsing: ambiguity never creates guessed slots. */
function legacyBatch(raw: string, spec: ProbeBuildSpec): { drafts: ProbeBuildDraft[]; skipReason?: string } {
  const batch = parseJson(raw) as { probes?: unknown[]; skipReason?: unknown };
  if (!batch || !Array.isArray(batch.probes) || batch.probes.length > spec.maxProbesPerVideo) throw new Error("legacy_plan_incomplete");
  const drafts = batch.probes.map(value => {
    if (!value || typeof value !== "object") throw new Error("legacy_plan_incomplete");
    const entry = value as Record<string, unknown>;
    const type = String(entry.probeType ?? entry.probe_type ?? entry.type).trim().toLowerCase() as ProbeBuildDraft["probeType"];
    if (!spec.allowedTypes.includes(type) || typeof entry.question !== "string" || !entry.question.trim()) throw new Error("legacy_plan_incomplete");
    const turns = Number(entry.targetTurns ?? entry.target_turns);
    return { probeType: type, question: entry.question.trim(), persona: typeof entry.persona === "string" && entry.persona.trim() ? entry.persona.trim() : "普通提问者", targetTurns: type === "hold_position" ? turns === 3 ? 3 : 2 : 1, anchor: typeof entry.anchor === "string" ? entry.anchor.trim() : "", trap: typeof entry.trap === "string" ? entry.trap.trim() : "" };
  });
  return { drafts, ...(typeof batch.skipReason === "string" ? { skipReason: batch.skipReason } : {}) };
}

function checkpointForLegacy(db: DatabaseSync, probe: ProbeRecord, spec: ProbeBuildSpec | null): ProbeBuildCheckpoint {
  const initial: ProbeBuildCheckpoint = { version: 1, stage: "critic", roundNo: probe.revisions + 1, turnNo: 1, attempt: 1 };
  if (probe.status !== "draft") return { ...initial, stage: "done" };
  const review = probe.reviews.at(-1);
  if (review?.decision === "revise" && probe.revisions < review.roundNo) return { ...initial, stage: "revision", roundNo: review.roundNo, review: { issues: review.issues, feedback: review.feedback } };
  if (review?.decision !== "accept") return initial;
  const turns = new EvalProbeRepo(db).listProbeTurns(probe.id);
  const turnNo = turns.length + 1;
  if (turns.length >= probe.targetTurns) return { ...initial, stage: "done", turnNo };
  let checkpoint: ProbeBuildCheckpoint = { ...initial, stage: turnNo === 1 ? "reference" : "adversary", turnNo, userContent: turnNo === 1 ? probe.question : undefined, trap: probe.trap, tactic: null };
  const calls = db.prepare("SELECT * FROM agent_calls WHERE run_ref = ? AND error IS NULL AND output_text IS NOT NULL ORDER BY id").all(`probe_build:${probe.runId}`).filter(call => {
    try { const refs = JSON.parse(String(call.input_refs_json)); return refs.probe_id === probe.id && refs.turn_no === turnNo; } catch { return false; }
  });
  if (turnNo > 1) {
    const adversary = calls.filter(c => c.role === "adversary").at(-1);
    if (!adversary) return checkpoint;
    try {
      const adv = parseJson(String(adversary.output_text)) as Record<string, unknown>;
      if (!ADVERSARY_TACTICS.includes(adv.tactic as typeof ADVERSARY_TACTICS[number]) || typeof adv.userContent !== "string" || !adv.userContent.trim()) return checkpoint;
      checkpoint = { ...checkpoint, stage: "reference", tactic: adv.tactic as typeof ADVERSARY_TACTICS[number], userContent: adv.userContent, trap: typeof adv.trap === "string" && adv.trap ? adv.trap : probe.trap };
    } catch { return checkpoint; }
  }
  const references = calls.filter(c => c.role === "reference");
  for (const reference of references) {
    const refs = JSON.parse(String(reference.input_refs_json));
    const attempt = Number(refs.attempt);
    if (!Number.isInteger(attempt) || attempt < checkpoint.attempt || (spec && attempt > spec.maxAnswerAttempts)) continue;
    const verifier = calls.filter(c => c.role === "verifier" && JSON.parse(String(c.input_refs_json)).attempt === attempt).at(-1);
    checkpoint = { ...checkpoint, stage: "verifier", attempt, answer: String(reference.output_text), pendingCallId: verifier ? Number(verifier.id) : undefined };
    if (verifier) {
      try {
        const result = parseJson(String(verifier.output_text)) as { decision?: string; feedback?: string };
        if (result.decision === "revise" && spec && attempt < spec.maxAnswerAttempts) checkpoint = { ...checkpoint, stage: "reference", attempt: attempt + 1, previousAnswer: checkpoint.answer, feedback: result.feedback, answer: undefined, pendingCallId: undefined };
      } catch { /* Revalidate preserved output through the public loop. */ }
    }
  }
  return checkpoint;
}

/** Caller must hold the writer session and an encompassing migration transaction. Idempotent. */
export function migrateLegacyProbeBuildPlans(db: DatabaseSync): LegacyBuildMigrationReport {
  const plans = new EvalBuildPlanRepo(db);
  const probes = new EvalProbeRepo(db);
  const sources = new EvalSourceRepo(db);
  const report: LegacyBuildMigrationReport = { createdPlans: 0, incompletePlanIds: [], conflictPlanIds: [] };
  const groups = new Map<string, { runId: number; sourceId: number }>();
  for (const row of db.prepare("SELECT DISTINCT run_id, source_material_id FROM probes p WHERE NOT EXISTS (SELECT 1 FROM probe_build_slots s WHERE s.probe_id = p.id) ORDER BY run_id, source_material_id").all()) groups.set(`${row.run_id}:${row.source_material_id}`, { runId: Number(row.run_id), sourceId: Number(row.source_material_id) });
  const writerCalls = db.prepare("SELECT * FROM agent_calls WHERE role = 'probe_writer' AND error IS NULL AND output_text IS NOT NULL ORDER BY id").all();
  for (const call of writerCalls) {
    try { const refs = JSON.parse(String(call.input_refs_json)); const match = /^probe_build:(\d+)$/.exec(String(call.run_ref)); if (match && refs.mode === "draft" && Number.isSafeInteger(refs.source_material_id)) groups.set(`${match[1]}:${refs.source_material_id}`, { runId: Number(match[1]), sourceId: refs.source_material_id }); } catch { /* Invalid audit metadata is not evidence. */ }
  }
  for (const { runId, sourceId } of [...groups.values()].sort((a, b) => a.runId - b.runId || a.sourceId - b.sourceId)) {
    if (plans.listBuildPlans({ originRunId: runId, sourceMaterialId: sourceId }).length) continue;
    const source = sources.getSourceMaterial(sourceId);
    const run = sources.getRun(runId);
    if (!source || !run || run.kind !== "probe_build") continue;
    const known = probes.listProbes({ runId, sourceMaterialId: sourceId });
    const spec = legacySpec(run);
    const matches = writerCalls.filter(call => {
      if (call.run_ref !== `probe_build:${runId}`) return false;
      try { const refs = JSON.parse(String(call.input_refs_json)); return refs.source_material_id === sourceId && refs.mode === "draft"; } catch { return false; }
    });
    let batch: ReturnType<typeof legacyBatch> | undefined;
    let conflict = false;
    if (spec && matches.length === 1) {
      try {
        batch = legacyBatch(String(matches[0]!.output_text), spec);
        conflict = known.some(p => {
          const draft = batch!.drafts[p.slotIndex - 1];
          return !draft || (p.revisions === 0 && (draft.question !== p.question || draft.probeType !== p.probeType || draft.targetTurns !== p.targetTurns || draft.anchor !== p.anchor || draft.trap !== p.trap || draft.persona !== p.persona));
        });
        if (conflict) batch = undefined;
      } catch { /* Keep known probes; report an incomplete batch. */ }
    }
    const generation = Number((db.prepare("SELECT COALESCE(max(generation),0)+1 AS n FROM probe_build_plans WHERE source_material_id = ?").get(sourceId) as { n: number }).n);
    const now = nowIso();
    const planId = Number(db.prepare(`INSERT INTO probe_build_plans (source_material_id,generation,origin_run_id,last_execution_run_id,source_sha256,spec_json,spec_hash,writer_call_id,status,planned_count,plan_complete,skip_reason,error_code,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sourceId, generation, runId, runId, source.contentSha256, spec ? JSON.stringify(spec) : null, spec ? probeBuildSpecHash(spec, source.contentSha256) : "legacy_unverified", matches.length === 1 ? Number(matches[0]!.id) : null, batch ? batch.drafts.length ? "ready" : "skipped" : "retryable", batch?.drafts.length ?? known.length, batch ? 1 : 0, batch && !batch.drafts.length ? batch.skipReason ?? "无合适考题" : null, batch ? null : conflict ? "checkpoint_invalid" : "legacy_plan_incomplete", now, now).lastInsertRowid);
    const drafts = batch ? batch.drafts.map((draft, i) => ({ draft, slotIndex: i + 1 })) : known.map(p => ({ draft: { probeType: p.probeType, persona: p.persona, targetTurns: p.targetTurns, question: p.question, anchor: p.anchor, trap: p.trap }, slotIndex: p.slotIndex }));
    for (const { draft, slotIndex } of drafts) {
      const probe = known.find(p => p.slotIndex === slotIndex);
      plans.insertBuildSlot({ planId, slotIndex, probeId: probe?.id ?? null, draft, executionRunId: runId, checkpoint: probe ? checkpointForLegacy(db, probe, spec) : { version: 1, stage: "critic", roundNo: 1, turnNo: 1, attempt: 1 }, status: probe && probe.status !== "draft" ? probe.status : "pending" });
    }
    plans.linkBuildExecution(runId, planId);
    plans.finishBuildExecution(runId, planId, {});
    report.createdPlans++;
    if (!batch) report.incompletePlanIds.push(planId);
    if (conflict) report.conflictPlanIds.push(planId);
  }
  return report;
}
