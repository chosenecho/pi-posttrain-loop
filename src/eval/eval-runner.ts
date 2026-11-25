import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  runWithRetry,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "../retry.js";
import { errorMessage, nonEmpty, validateConcurrency } from "../schema.js";
import { runConcurrentPool } from "../shared/concurrency.js";
import type { CandidateRunner, ChatMessage } from "./candidate-client.js";
import {
  EvalStore,
  type EvalHistoryMode,
  type SuiteItemRecord,
} from "./eval-db.js";

export interface SuiteDialogueTurn {
  turnNo: number;
  user: string;
  referenceAnswer: string;
}

/**
 * Extracts ordered `(user, referenceAnswer)` turn pairs from a frozen suite item's `messages`.
 */
export function extractSuiteDialogueTurns(item: Pick<SuiteItemRecord, "itemKey" | "messages">): SuiteDialogueTurn[] {
  const nonSystem = item.messages.filter((m) => m.role !== "system");
  if (nonSystem.length === 0 || nonSystem.length % 2 !== 0) {
    throw new Error(`套卷条目 ${item.itemKey} 的 messages 轮次格式异常（共 ${nonSystem.length} 条非 system 消息）`);
  }
  const turns: SuiteDialogueTurn[] = [];
  for (let i = 0; i < nonSystem.length; i += 2) {
    const userMsg = nonSystem[i]!;
    const assistantMsg = nonSystem[i + 1]!;
    if (userMsg.role !== "user" || assistantMsg.role !== "assistant") {
      throw new Error(
        `套卷条目 ${item.itemKey} 第 ${i / 2 + 1} 轮角色顺序错误（实际 ${userMsg.role}/${assistantMsg.role}）`,
      );
    }
    turns.push({
      turnNo: i / 2 + 1,
      user: userMsg.content,
      referenceAnswer: assistantMsg.content,
    });
  }
  return turns;
}

export interface RunSuiteEvaluationOptions {
  evalStore: EvalStore;
  suiteName: string;
  candidate: string;
  modelId: string;
  historyMode?: EvalHistoryMode;
  /** `undefined` inherits on resume (or omits on new run); `null` explicitly disables system prompt. */
  systemPrompt?: string | null;
  temperature?: number;
  maxTokens?: number;
  runCandidate: CandidateRunner;
  resumeRunId?: number;
  limit?: number;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  onProgress?: (message: string) => void;
}

export interface RunSuiteEvaluationSummary {
  evalRunId: number;
  resumed: boolean;
  suiteName: string;
  suiteKind: "in_distribution" | "adversarial";
  candidate: string;
  modelId: string;
  historyMode: EvalHistoryMode;
  totalItems: number;
  totalTurns: number;
  completedTurns: number;
  skippedExistingTurns: number;
  errorTurns: number;
  totalAgentCalls: number;
}

/**
 * Runs a candidate model completely transcript-free against a frozen suite (`indist-v1` / `adv-v1`).
 * Supports `gold` (reference prior turns) and `self` (candidate's own prior turns) history modes,
 * plus safe resumption via `resumeRunId`.
 */
export async function runSuiteEvaluation(
  options: RunSuiteEvaluationOptions,
): Promise<RunSuiteEvaluationSummary> {
  const { evalStore, runCandidate } = options;
  const concurrency = validateConcurrency(options.concurrency ?? 4);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);

  evalStore.markInterruptedRuns();

  let evalRunId: number;
  let resumed = false;
  let suiteName = nonEmpty(options.suiteName, "--suite");
  let candidate = nonEmpty(options.candidate, "--candidate");
  let modelId = nonEmpty(options.modelId, "--model");
  let historyMode: EvalHistoryMode = options.historyMode ?? "gold";
  let effectiveSystemPrompt: string | undefined;

  const suite = evalStore.getSuite(suiteName);
  if (!suite) {
    throw new Error(`评测库中未找到冻结套卷：${suiteName}`);
  }

  if (options.resumeRunId !== undefined) {
    const existingRun = evalStore.getEvalRun(options.resumeRunId);
    if (!existingRun) {
      throw new Error(`未找到可续跑的 eval_run #${options.resumeRunId}`);
    }
    if (existingRun.suiteId !== suite.id) {
      throw new Error(`eval_run #${existingRun.id} 属于套卷 ${existingRun.suiteName}，与 --suite ${suiteName} 不一致`);
    }
    if (existingRun.candidate !== candidate) {
      throw new Error(`eval_run #${existingRun.id} 候选名为 ${existingRun.candidate}，与 --candidate ${candidate} 不一致`);
    }
    if (options.historyMode !== undefined && existingRun.historyMode !== options.historyMode) {
      throw new Error(`eval_run #${existingRun.id} 历史模式为 ${existingRun.historyMode}，与 --history-mode ${options.historyMode} 不一致`);
    }
    const storedSystemPrompt =
      typeof existingRun.config.systemPrompt === "string" && existingRun.config.systemPrompt.trim().length > 0
        ? existingRun.config.systemPrompt.trim()
        : undefined;
    if (options.systemPrompt === undefined) {
      effectiveSystemPrompt = storedSystemPrompt;
    } else if (options.systemPrompt === null) {
      if (storedSystemPrompt !== undefined) {
        throw new Error(`eval_run #${existingRun.id} 原配置包含系统提示词，与 --no-system-prompt 不一致`);
      }
      effectiveSystemPrompt = undefined;
    } else {
      const requestedPrompt = nonEmpty(options.systemPrompt, "systemPrompt");
      if (requestedPrompt !== storedSystemPrompt) {
        throw new Error(`eval_run #${existingRun.id} 原系统提示词与本次指定的不一致`);
      }
      effectiveSystemPrompt = requestedPrompt;
    }
    evalRunId = existingRun.id;
    historyMode = existingRun.historyMode;
    modelId = existingRun.model;
    resumed = true;
    evalStore.reopenEvalRun(evalRunId, {
      resumedAt: new Date().toISOString(),
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
    });
  } else {
    effectiveSystemPrompt =
      options.systemPrompt !== undefined && options.systemPrompt !== null
        ? nonEmpty(options.systemPrompt, "systemPrompt")
        : undefined;
    evalRunId = evalStore.createEvalRun({
      suiteId: suite.id,
      candidate,
      model: modelId,
      historyMode,
      config: {
        suiteName: suite.name,
        suiteSha256: suite.sha256,
        candidate,
        modelId,
        historyMode,
        hasSystemPrompt: Boolean(effectiveSystemPrompt),
        ...(effectiveSystemPrompt ? { systemPrompt: effectiveSystemPrompt } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        concurrency,
        callMaxAttempts,
        callRetryDelayMs,
      },
    });
  }

  const runRef = `eval_run:${evalRunId}`;
  let items = evalStore.listSuiteItemsBySuiteId(suite.id);
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new Error("--limit 必须是正整数");
    }
    items = items.slice(0, options.limit);
  }
  if (items.length === 0) {
    evalStore.finishEvalRun(evalRunId, "failed", "套卷没有任何条目");
    throw new Error(`套卷 ${suite.name} 没有任何条目`);
  }

  // Index existing valid predictions when resuming
  const existingOkByKey = new Map<string, string>();
  if (resumed) {
    for (const pred of evalStore.listEvalPredictions(evalRunId)) {
      if (pred.outputText !== null && pred.outputText.trim().length > 0 && pred.error === null) {
        existingOkByKey.set(`${pred.suiteItemId}:${pred.turnNo}`, pred.outputText);
      }
    }
  }

  let totalTurns = 0;
  let completedTurns = 0;
  let skippedExistingTurns = 0;
  let errorTurns = 0;

  try {
    await runConcurrentPool(items, concurrency, async (item, itemIdx) => {
      const turns = extractSuiteDialogueTurns(item);
      totalTurns += turns.length;
      const tag = `[${itemIdx + 1}/${items.length} ${item.itemKey}${item.probeType ? `:${item.probeType}` : ""}]`;

      const priorHistory: ChatMessage[] = [];
      let selfModeBroken = false;

      for (const turn of turns) {
        const predKey = `${item.id}:${turn.turnNo}`;
        const existingAnswer = existingOkByKey.get(predKey);

        const requestMessages: ChatMessage[] = [
          ...(effectiveSystemPrompt ? [{ role: "system" as const, content: effectiveSystemPrompt }] : []),
          ...priorHistory,
          { role: "user", content: turn.user },
        ];
        const inputSnapshot: Record<string, unknown> = {
          historyMode,
          messages: requestMessages,
        };

        if (existingAnswer !== undefined) {
          skippedExistingTurns++;
          completedTurns++;
          priorHistory.push({ role: "user", content: turn.user });
          priorHistory.push({
            role: "assistant",
            content: historyMode === "gold" ? turn.referenceAnswer : existingAnswer,
          });
          continue;
        }

        if (historyMode === "self" && selfModeBroken) {
          errorTurns++;
          evalStore.saveEvalPrediction({
            evalRunId,
            suiteItemId: item.id,
            turnNo: turn.turnNo,
            input: inputSnapshot,
            outputText: null,
            error: "前序轮次作答失败，无法构造 self 模式对话历史",
            callId: null,
          });
          continue;
        }

        let lastCallId: number | null = null;
        try {
          const answer = await runWithRetry({
            maxAttempts: callMaxAttempts,
            delayMs: callRetryDelayMs,
            onRetry: (attempt: number, max: number, error: unknown) => {
              options.onProgress?.(`${tag}[t${turn.turnNo}] 重试 ${attempt}/${max}：${errorMessage(error)}`);
            },
            run: async (): Promise<string> => {
              const callId = evalStore.startCall({
                runRef,
                role: "candidate",
                model: modelId,
                inputRefs: {
                  suite_item_id: item.id,
                  item_key: item.itemKey,
                  turn_no: turn.turnNo,
                  history_mode: historyMode,
                },
              });
              lastCallId = callId;
              try {
                const raw = await runCandidate({
                  messages: requestMessages,
                  temperature: options.temperature,
                  maxTokens: options.maxTokens,
                });
                const trimmed = nonEmpty(raw, "候选模型回答");
                evalStore.finishCall(callId, { output: trimmed });
                return trimmed;
              } catch (error) {
                evalStore.finishCall(callId, { error: errorMessage(error) });
                throw error;
              }
            },
          });

          evalStore.saveEvalPrediction({
            evalRunId,
            suiteItemId: item.id,
            turnNo: turn.turnNo,
            input: inputSnapshot,
            outputText: answer,
            error: null,
            callId: lastCallId,
          });
          completedTurns++;
          priorHistory.push({ role: "user", content: turn.user });
          priorHistory.push({
            role: "assistant",
            content: historyMode === "gold" ? turn.referenceAnswer : answer,
          });
        } catch (error) {
          const errMsg = errorMessage(error);
          errorTurns++;
          evalStore.saveEvalPrediction({
            evalRunId,
            suiteItemId: item.id,
            turnNo: turn.turnNo,
            input: inputSnapshot,
            outputText: null,
            error: errMsg,
            callId: lastCallId,
          });
          options.onProgress?.(`${tag}[t${turn.turnNo}] 失败：${errMsg}`);
          if (historyMode === "self") {
            selfModeBroken = true;
          } else {
            priorHistory.push({ role: "user", content: turn.user });
            priorHistory.push({ role: "assistant", content: turn.referenceAnswer });
          }
        }
      }

      options.onProgress?.(`${tag} 完成（${turns.length} 轮）`);
    });

    evalStore.finishEvalRun(evalRunId, "completed");
  } catch (error) {
    evalStore.finishEvalRun(evalRunId, "failed", errorMessage(error));
    throw error;
  }

  const totalCallsRow = evalStore.db
    .prepare("SELECT count(*) AS c FROM agent_calls WHERE run_ref = ? AND role = 'candidate'")
    .get(runRef) as { c: number };

  return {
    evalRunId,
    resumed,
    suiteName: suite.name,
    suiteKind: suite.kind,
    candidate,
    modelId,
    historyMode,
    totalItems: items.length,
    totalTurns,
    completedTurns,
    skippedExistingTurns,
    errorTurns,
    totalAgentCalls: Number(totalCallsRow.c),
  };
}
