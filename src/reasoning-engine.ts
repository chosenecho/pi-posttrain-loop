import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSeededRng } from "./db.js";
import { createPiRunner, readPiConfig, type PiConfig, type ThinkingLevel } from "./pi-runner.js";
import {
  computeBatchStats,
  DEFAULT_REASONING_CHECK_CONFIG,
  formatTierTargetRange,
  runRuleChecks,
  type ReasoningBatchStats,
  type ReasoningCheckConfig,
  type RuleCheckMetrics,
  type ThinkTier,
  type TraceStatInput,
} from "./reasoning-checks.js";
import {
  ReasoningStore,
  type CandidateTurn,
  type ReasoningTraceDecision,
} from "./reasoning-store.js";
import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  runWithRetry,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "./retry.js";
import { errorMessage, nonEmpty, parseReview, validateConcurrency } from "./schema.js";
import type { Review, RoleRunner, Skill } from "./types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_REASONING_WRITER_SKILL = join(ROOT, "skills/reasoning-writer/SKILL.md");
export const DEFAULT_REASONING_JUDGE_SKILL = join(ROOT, "skills/reasoning-judge/SKILL.md");
export const DEFAULT_REASONING_PROMPTS_DIR = join(ROOT, "prompts");

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "max"];

async function loadReadySkill(path: string, label: string): Promise<Skill> {
  const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${label} 需要 YAML frontmatter，并设置 status: placeholder 或 ready`);
  const statuses = [...match[1].matchAll(/^status:\s*(placeholder|ready)\s*$/gm)];
  if (statuses.length !== 1) throw new Error(`${label} 必须恰好设置一次 status: placeholder 或 ready`);
  const status = statuses[0][1] as Skill["status"];
  const body = match[2].trim();
  if (!body) throw new Error(`${label} 正文为空`);
  if (status === "ready" && /\bTODO\b|占位模式的输出/.test(body)) {
    throw new Error(`${label} 仍含 TODO 或占位输出段，请先填写规则再启用 ready`);
  }
  return { status, body, sha256: createHash("sha256").update(text).digest("hex") };
}

export function readReasoningWriterSkill(path = DEFAULT_REASONING_WRITER_SKILL): Promise<Skill> {
  return loadReadySkill(path, "思考补写 Skill");
}

export function readReasoningJudgeSkill(path = DEFAULT_REASONING_JUDGE_SKILL): Promise<Skill> {
  return loadReadySkill(path, "思考质检 Skill");
}

export async function readReasoningPrompts(directory = DEFAULT_REASONING_PROMPTS_DIR): Promise<{
  writer: string;
  judge: string;
}> {
  const [writer, judge] = await Promise.all([
    readFile(join(directory, "reasoning-writer.md"), "utf8"),
    readFile(join(directory, "reasoning-judge.md"), "utf8"),
  ]);
  return {
    writer: nonEmpty(writer, "reasoning-writer 系统提示词"),
    judge: nonEmpty(judge, "reasoning-judge 系统提示词"),
  };
}

export function composeReasoningWriterPrompt(systemPrompt: string, skillBody: string): string {
  return `${systemPrompt}\n\n<reasoning-writer>\n${skillBody}\n</reasoning-writer>`;
}

export function composeReasoningJudgePrompt(systemPrompt: string, skillBody: string): string {
  return `${systemPrompt}\n\n<reasoning-judge>\n${skillBody}\n</reasoning-judge>`;
}

function parseOptionalThinkingLevel(raw: string | undefined, envName: string): ThinkingLevel | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (!THINKING_LEVELS.includes(trimmed as ThinkingLevel)) {
    throw new Error(`${envName} 必须是 off、low、medium、high 或 max`);
  }
  return trimmed as ThinkingLevel;
}

function parseOptionalInt(raw: string | undefined, envName: string, min: number, max: number): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${envName} 必须是 ${min}–${max} 的整数`);
  }
  return value;
}

/**
 * Reads independent REASONING_* and REASONING_JUDGE_* API configs with automatic fallback
 * to the standard LLM_* variables in .env. This allows plugging in a locally served
 * Qwen3.8-27B base endpoint as the CoT writer without touching the main generation config.
 */
export function readReasoningPiConfigs(env: NodeJS.ProcessEnv = process.env): {
  writer: PiConfig;
  judge: PiConfig;
} {
  const baseEnv: NodeJS.ProcessEnv = {
    ...env,
    LLM_BASE_URL: env.REASONING_BASE_URL?.trim() || env.LLM_BASE_URL,
    LLM_MODEL: env.REASONING_MODEL?.trim() || env.LLM_MODEL,
    LLM_API_KEY: env.REASONING_API_KEY?.trim() || env.LLM_API_KEY,
  };
  const writerBase = readPiConfig(baseEnv);
  const writerThinking = parseOptionalThinkingLevel(env.REASONING_THINKING_LEVEL, "REASONING_THINKING_LEVEL")
    ?? writerBase.thinkingLevel
    ?? "medium";
  const writer: PiConfig = {
    ...writerBase,
    maxTokens: parseOptionalInt(env.REASONING_MAX_TOKENS, "REASONING_MAX_TOKENS", 128, writerBase.contextWindow - 1)
      ?? writerBase.maxTokens,
    timeoutMs: parseOptionalInt(env.REASONING_TIMEOUT_MS, "REASONING_TIMEOUT_MS", 1000, 3_600_000)
      ?? writerBase.timeoutMs,
    thinkingLevel: writerThinking,
    roleThinkingLevels: { answer: writerThinking },
  };

  const judgeEnv: NodeJS.ProcessEnv = {
    ...env,
    LLM_BASE_URL: env.REASONING_JUDGE_BASE_URL?.trim() || env.LLM_BASE_URL || env.REASONING_BASE_URL,
    LLM_MODEL: env.REASONING_JUDGE_MODEL?.trim() || env.LLM_MODEL || env.REASONING_MODEL,
    LLM_API_KEY: env.REASONING_JUDGE_API_KEY?.trim() || env.LLM_API_KEY || env.REASONING_API_KEY,
  };
  const judgeBase = readPiConfig(judgeEnv);
  const judgeThinking = parseOptionalThinkingLevel(env.REASONING_JUDGE_THINKING_LEVEL, "REASONING_JUDGE_THINKING_LEVEL")
    ?? judgeBase.roleThinkingLevels?.judge
    ?? "low";
  const judge: PiConfig = {
    ...judgeBase,
    thinkingLevel: judgeThinking,
    roleThinkingLevels: { judge: judgeThinking },
  };

  return { writer, judge };
}

export function createReasoningRunners(configs: { writer: PiConfig; judge: PiConfig }): {
  runWriter: RoleRunner;
  runJudge: RoleRunner;
} {
  return {
    runWriter: createPiRunner(configs.writer),
    runJudge: createPiRunner(configs.judge),
  };
}

function shuffleWithRng<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Deterministically selects up to `limit` turns balanced across (lengthTier x turnNo) strata
 * while spreading picks across distinct videoKeys.
 */
export function selectStratifiedTurns(
  candidates: CandidateTurn[],
  limit: number,
  seed = 42,
): CandidateTurn[] {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error("limit 必须是非负整数");
  }
  if (limit === 0 || candidates.length === 0) return [];
  if (limit >= candidates.length) return [...candidates];

  const rng = createSeededRng(seed);
  const tierOrder: ThinkTier[] = ["short", "medium", "long"];
  const turnNos = [...new Set(candidates.map((c) => c.turnNo))].sort((a, b) => a - b);

  const buckets: CandidateTurn[][] = [];
  for (const tier of tierOrder) {
    for (const turnNo of turnNos) {
      const group = candidates.filter((c) => c.lengthTier === tier && c.turnNo === turnNo);
      if (group.length > 0) {
        buckets.push(shuffleWithRng(group, rng));
      }
    }
  }

  const selected: CandidateTurn[] = [];
  const videoUseCounts = new Map<string, number>();

  while (selected.length < limit) {
    let progressed = false;
    for (const bucket of buckets) {
      if (selected.length >= limit) break;
      if (bucket.length === 0) continue;

      // Prefer the candidate in this stratum whose videoKey has been sampled the fewest times
      let bestIdx = 0;
      let bestCount = videoUseCounts.get(bucket[0].videoKey) ?? 0;
      for (let i = 1; i < bucket.length; i++) {
        const count = videoUseCounts.get(bucket[i].videoKey) ?? 0;
        if (count < bestCount) {
          bestCount = count;
          bestIdx = i;
          if (bestCount === 0) break;
        }
      }
      const [picked] = bucket.splice(bestIdx, 1);
      selected.push(picked);
      videoUseCounts.set(picked.videoKey, (videoUseCounts.get(picked.videoKey) ?? 0) + 1);
      progressed = true;
    }
    if (!progressed) break;
  }

  return selected;
}

export interface AttemptAuditEntry {
  attemptNo: number;
  rulePassed: boolean;
  ruleIssues: string[];
  llmDecision: Review["decision"] | null;
  llmIssues: string[];
  feedback: string;
  charCount: number;
  ngram8Overlap: number;
}

export interface ReasoningBackfillOptions {
  store: ReasoningStore;
  candidates: CandidateTurn[];
  writerPrompt: string;
  writerSkill: Skill;
  writerSkillPath: string;
  judgePrompt?: string;
  judgeSkill?: Skill;
  judgeSkillPath?: string;
  runWriter: RoleRunner;
  runJudge?: RoleRunner;
  writerModel: string;
  judgeModel?: string | null;
  checkConfig?: ReasoningCheckConfig;
  maxRewrites?: number;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  configSnapshot?: Record<string, unknown>;
  onProgress?: (event: { completed: number; total: number; turn: CandidateTurn; decision: ReasoningTraceDecision | "error" }) => void;
}

export interface ReasoningBackfillResult {
  reasoningRunId: number;
  selectedTurns: number;
  stats: ReasoningBatchStats;
}

function validateMaxRewrites(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 5) {
    throw new Error("maxRewrites 必须是 0–5 的整数");
  }
  return value;
}

export async function runReasoningBackfill(options: ReasoningBackfillOptions): Promise<ReasoningBackfillResult> {
  const maxRewrites = validateMaxRewrites(options.maxRewrites ?? 3);
  const concurrency = validateConcurrency(options.concurrency ?? 10);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);
  const checkConfig = options.checkConfig ?? DEFAULT_REASONING_CHECK_CONFIG;
  const useLlmJudge = Boolean(options.runJudge && options.judgePrompt && options.judgeSkill);

  const composedWriterPrompt = composeReasoningWriterPrompt(options.writerPrompt, options.writerSkill.body);
  const composedJudgePrompt = useLlmJudge
    ? composeReasoningJudgePrompt(options.judgePrompt!, options.judgeSkill!.body)
    : undefined;

  const skillsSnapshot: unknown[] = [
    {
      name: "reasoning-writer",
      path: options.writerSkillPath,
      status: options.writerSkill.status,
      sha256: options.writerSkill.sha256,
      body: options.writerSkill.body,
    },
  ];
  if (useLlmJudge && options.judgeSkill) {
    skillsSnapshot.push({
      name: "reasoning-judge",
      path: options.judgeSkillPath ?? DEFAULT_REASONING_JUDGE_SKILL,
      status: options.judgeSkill.status,
      sha256: options.judgeSkill.sha256,
      body: options.judgeSkill.body,
    });
  }

  const reasoningRunId = options.store.createReasoningRun({
    writerModel: options.writerModel,
    judgeModel: useLlmJudge ? (options.judgeModel ?? options.writerModel) : null,
    config: {
      maxRewrites,
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
      useLlmJudge,
      checkConfig,
      ...(options.configSnapshot ?? {}),
    },
    prompts: {
      writer: composedWriterPrompt,
      ...(composedJudgePrompt ? { judge: composedJudgePrompt } : {}),
    },
    skills: skillsSnapshot,
  });

  const statItems: TraceStatInput[] = new Array(options.candidates.length);
  let nextIndex = 0;
  let completedCount = 0;

  async function processOne(index: number): Promise<void> {
    const turn = options.candidates[index];
    const traceId = options.store.startTrace({
      reasoningRunId,
      attemptId: turn.attemptId,
      resultId: turn.resultId,
      turnNo: turn.turnNo,
      lengthTier: turn.lengthTier,
    });

    const attemptsLog: AttemptAuditEntry[] = [];
    let previousReasoning: string | undefined;
    let feedback: string | undefined;
    let lastRawOutput: string | null = null;
    let lastMetrics: RuleCheckMetrics | null = null;
    let lastLlmReview: Review | null = null;
    let finalDecision: ReasoningTraceDecision | null = null;
    let finalReasoning: string | null = null;
    let rewriteCount = 0;

    try {
      const totalAttempts = maxRewrites + 1;
      for (let attemptNo = 1; attemptNo <= totalAttempts; attemptNo++) {
        rewriteCount = attemptNo - 1;
        const spec = checkConfig.tiers[turn.lengthTier];
        const writerInput: Record<string, unknown> = {
          ...(turn.history.length > 0 ? { history: turn.history } : {}),
          question: turn.question,
          answer: turn.answer,
          targetThinkTier: turn.lengthTier,
          targetChars: formatTierTargetRange(spec),
          ...(previousReasoning !== undefined && feedback !== undefined
            ? { previousReasoning, feedback }
            : {}),
        };

        const rawWriter = await runWithRetry({
          maxAttempts: callMaxAttempts,
          delayMs: callRetryDelayMs,
          run: () =>
            options.runWriter({
              role: "answer",
              systemPrompt: composedWriterPrompt,
              input: writerInput,
            }),
        });
        const candidateReasoning = rawWriter.trim();
        lastRawOutput = rawWriter;

        const ruleResult = runRuleChecks(candidateReasoning, turn.answer, turn.lengthTier, checkConfig);
        lastMetrics = ruleResult.metrics;

        if (!ruleResult.passed) {
          attemptsLog.push({
            attemptNo,
            rulePassed: false,
            ruleIssues: ruleResult.issues,
            llmDecision: null,
            llmIssues: [],
            feedback: ruleResult.feedback,
            charCount: ruleResult.metrics.charCount,
            ngram8Overlap: ruleResult.metrics.ngram8Overlap,
          });
          previousReasoning = candidateReasoning;
          feedback = ruleResult.feedback;
          continue;
        }

        if (!useLlmJudge || !options.runJudge || !composedJudgePrompt) {
          attemptsLog.push({
            attemptNo,
            rulePassed: true,
            ruleIssues: [],
            llmDecision: null,
            llmIssues: [],
            feedback: "",
            charCount: ruleResult.metrics.charCount,
            ngram8Overlap: ruleResult.metrics.ngram8Overlap,
          });
          finalDecision = "pass";
          finalReasoning = candidateReasoning;
          break;
        }

        const judgeInput: Record<string, unknown> = {
          ...(turn.history.length > 0 ? { history: turn.history } : {}),
          question: turn.question,
          answer: turn.answer,
          reasoning: candidateReasoning,
          targetThinkTier: turn.lengthTier,
        };

        const review = await runWithRetry({
          maxAttempts: callMaxAttempts,
          delayMs: callRetryDelayMs,
          run: async () => {
            const rawJudge = await options.runJudge!({
              role: "judge",
              systemPrompt: composedJudgePrompt,
              input: judgeInput,
            });
            return parseReview(rawJudge);
          },
        });
        lastLlmReview = review;

        attemptsLog.push({
          attemptNo,
          rulePassed: true,
          ruleIssues: [],
          llmDecision: review.decision,
          llmIssues: review.issues,
          feedback: review.feedback,
          charCount: ruleResult.metrics.charCount,
          ngram8Overlap: ruleResult.metrics.ngram8Overlap,
        });

        if (review.decision === "pass") {
          finalDecision = "pass";
          finalReasoning = candidateReasoning;
          break;
        }
        if (review.decision === "drop") {
          finalDecision = "drop";
          finalReasoning = candidateReasoning;
          break;
        }
        previousReasoning = candidateReasoning;
        feedback = review.feedback;
      }

      if (finalDecision === null) {
        finalDecision = "drop";
        finalReasoning = previousReasoning ?? null;
      }

      options.store.completeTrace(traceId, {
        status: "completed",
        decision: finalDecision,
        rewriteCount,
        reasoning: finalDecision === "pass" ? finalReasoning : null,
        checks: {
          finalMetrics: lastMetrics,
          llmReview: lastLlmReview,
          attempts: attemptsLog,
        },
        rawOutput: lastRawOutput,
        error: null,
      });

      statItems[index] = {
        status: "completed",
        decision: finalDecision,
        lengthTier: turn.lengthTier,
        reasoning: finalDecision === "pass" ? finalReasoning : null,
        metrics: lastMetrics,
        rewriteCount,
      };
      completedCount++;
      options.onProgress?.({ completed: completedCount, total: options.candidates.length, turn, decision: finalDecision });
    } catch (error) {
      const msg = errorMessage(error);
      options.store.completeTrace(traceId, {
        status: "error",
        decision: null,
        rewriteCount,
        reasoning: null,
        checks: lastMetrics || attemptsLog.length > 0
          ? { finalMetrics: lastMetrics, llmReview: lastLlmReview, attempts: attemptsLog }
          : null,
        rawOutput: lastRawOutput,
        error: msg,
      });
      statItems[index] = {
        status: "error",
        decision: null,
        lengthTier: turn.lengthTier,
        reasoning: null,
        metrics: lastMetrics,
        rewriteCount,
      };
      completedCount++;
      options.onProgress?.({ completed: completedCount, total: options.candidates.length, turn, decision: "error" });
    }
  }

  try {
    const workerCount = Math.min(concurrency, Math.max(1, options.candidates.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const current = nextIndex++;
        if (current >= options.candidates.length) return;
        await processOne(current);
      }
    });
    await Promise.all(workers);
    options.store.finishReasoningRun(reasoningRunId, "completed");
  } catch (error) {
    options.store.finishReasoningRun(reasoningRunId, "error", errorMessage(error));
    throw error;
  }

  return {
    reasoningRunId,
    selectedTurns: options.candidates.length,
    stats: computeBatchStats(statItems),
  };
}
