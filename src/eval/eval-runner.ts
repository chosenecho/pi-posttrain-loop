import { runConcurrentPool } from "../shared/concurrency.js";
import { combineSignals, createAttemptCancellation, rethrowIfAborted, throwIfAborted } from "../shared/cancellation.js";
import { publicErrorMessage, toPublicError } from "../shared/public-error.js";
import { runWithRetry } from "../shared/retry.js";
import { nonEmpty } from "../shared/schema.js";
import { bindCandidate, createOpenAiCandidate, readCandidateOperationalConfig, type CandidateFactory, type CandidateRunner, type ChatMessage } from "./candidate-client.js";
import { EvaluationSpecError, resolveEvaluationSpec } from "./evaluation-spec.js";
import { EvalStore, type EvalHistoryMode, type SuiteItemRecord } from "./store/index.js";

export interface SuiteDialogueTurn {
  turnNo: number;
  user: string;
  referenceAnswer: string;
}

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
  modelId?: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  stripThinkTags?: boolean;
  adapterContractVersion?: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  historyMode?: EvalHistoryMode;
  systemPrompt?: string | null;
  temperature?: number;
  maxTokens?: number;
  candidateFactory?: CandidateFactory;
  /** Raw runner compatibility requires an explicit resolved-spec identity assertion. */
  runCandidate?: CandidateRunner;
  candidateSpecHash?: string;
  resumeRunId?: number;
  parentRunId?: number;
  itemIds?: readonly number[];
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
  candidate: string;
  modelId: string;
  historyMode: EvalHistoryMode;
  specHash: string;
  endpoint: string;
  totalItems: number;
  totalTurns: number;
  completedTurns: number;
  skippedExistingTurns: number;
  errorTurns: number;
  totalAgentCalls: number;
}

/**
 * Runs a candidate model completely transcript-free against a frozen suite.
 * Supports `gold` (reference prior turns) and `self` (candidate's own prior turns) history modes,
 * plus resumption via `resumeRunId`.
 */
export async function runSuiteEvaluation(
  options: RunSuiteEvaluationOptions,
): Promise<RunSuiteEvaluationSummary> {
  const { evalStore } = options;
  const taskSignal = combineSignals(options.signal, evalStore.signal);
  throwIfAborted(taskSignal);
  const suiteName = nonEmpty(options.suiteName, "--suite");
  const suite = evalStore.getSuite(suiteName);
  if (!suite) throw new Error(`评测库中未找到冻结套卷：${suiteName}`);
  if (options.parentRunId !== undefined) {
    if (options.resumeRunId !== undefined) throw new Error("parentRunId 与 resumeRunId 只能指定一项 [resume_config_conflict]");
    const parent = evalStore.getEvalRun(options.parentRunId);
    if (!parent) throw new Error("关联的父评测运行不存在 [parent_run_missing]");
    if (parent.suiteId !== suite.id) throw new Error("关联的父评测运行属于其他套卷 [parent_run_suite_conflict]");
  }
  const existingRun = options.resumeRunId === undefined ? undefined : evalStore.getEvalRun(options.resumeRunId);
  if (options.resumeRunId !== undefined && !existingRun) throw new Error(`未找到可续跑的 eval_run #${options.resumeRunId}`);
  const allItems = evalStore.listSuiteItems(suite.id);
  const spec = resolveEvaluationSpec({ suite, items: allItems, requested: options, existingRun, environment: options.environment });
  const runtime = readCandidateOperationalConfig(spec, options, options.environment ?? process.env);
  if (options.runCandidate && options.candidateFactory) throw new Error("candidateFactory 与 runCandidate 只能指定一项");
  if (options.runCandidate && options.candidateSpecHash !== spec.hash) {
    throw new EvaluationSpecError("candidate_identity_mismatch", "裸 runner 必须显式绑定同一规格 hash，或使用 candidateFactory + bindCandidate");
  }
  const adapter = options.runCandidate
    ? bindCandidate(spec, options.runCandidate)
    : (options.candidateFactory ?? createOpenAiCandidate)(spec, runtime);
  if (adapter.specHash !== spec.hash) throw new EvaluationSpecError("candidate_identity_mismatch", "候选 adapter 的规格身份不匹配");
  const { concurrency, callMaxAttempts, callRetryDelayMs } = runtime;
  const { candidate, modelId, historyMode, systemPrompt: effectiveSystemPrompt } = spec;
  const itemsById = new Map(allItems.map((item) => [item.id, item]));
  const items = spec.itemIds.map((id) => itemsById.get(id)!);
  for (const item of items) extractSuiteDialogueTurns(item);

  // Validation and adapter identity checks must precede recovery or any run mutation.
  throwIfAborted(taskSignal);
  evalStore.ensureRecovered();
  const resumed = existingRun !== undefined;
  let evalRunId: number;
  if (existingRun) {
    evalRunId = existingRun.id;
    evalStore.reopenEvalRun(evalRunId);
  } else {
    evalRunId = evalStore.createEvalRun({
      suiteId: spec.suiteId, candidate, model: modelId, historyMode, systemPrompt: effectiveSystemPrompt,
      config: { evaluationSpec: spec, ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }), operationalExecutions: [] },
    });
  }
  evalStore.recordEvaluationExecution(evalRunId, { timeoutMs: runtime.timeoutMs, concurrency, callMaxAttempts, callRetryDelayMs });
  const runRef = `eval_run:${evalRunId}`;

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
    await runConcurrentPool(items, concurrency, async (item, itemIdx, workerSignal) => {
      throwIfAborted(workerSignal);
      const turns = extractSuiteDialogueTurns(item);
      totalTurns += turns.length;
      const tag = `[${itemIdx + 1}/${items.length} ${item.itemKey}:${item.probeType}]`;

      const priorHistory: ChatMessage[] = [];
      let selfModeBroken = false;

      for (const turn of turns) {
        throwIfAborted(workerSignal);
        const predKey = `${item.id}:${turn.turnNo}`;
        const existingAnswer = existingOkByKey.get(predKey);

        const requestMessages: ChatMessage[] = [
          ...(effectiveSystemPrompt ? [{ role: "system" as const, content: effectiveSystemPrompt }] : []),
          ...priorHistory,
          { role: "user", content: turn.user },
        ];
        const inputSnapshot: Record<string, unknown> = {
          specHash: spec.hash,
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
            signal: workerSignal,
            onRetry: (attempt, max, error) => {
              options.onProgress?.(`${tag}[t${turn.turnNo}] 重试 ${attempt}/${max}：${publicErrorMessage(error)}`);
            },
            run: async () => {
              const callId = evalStore.startCall({
                runRef,
                role: "candidate",
                model: modelId,
                inputRefs: {
                  suite_item_id: item.id,
                  item_key: item.itemKey,
                  turn_no: turn.turnNo,
                  history_mode: historyMode,
                  spec_hash: spec.hash,
                },
              });
              lastCallId = callId;
              const cancellation = createAttemptCancellation(workerSignal, runtime.timeoutMs);
              try {
                const raw = await adapter.run({ messages: requestMessages, signal: cancellation.signal });
                throwIfAborted(cancellation.signal);
                let trimmed: string;
                try {
                  trimmed = nonEmpty(raw, "候选模型回答");
                } catch (error) {
                  throw toPublicError(error, "model_output_invalid");
                }
                evalStore.finishCall(callId, { output: trimmed });
                return trimmed;
              } catch (error) {
                let failure = error;
                try { rethrowIfAborted(error, cancellation.signal); } catch (aborted) { failure = aborted; }
                evalStore.finishCall(callId, { error: publicErrorMessage(failure) });
                throw toPublicError(failure);
              } finally {
                cancellation.dispose();
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
          rethrowIfAborted(error, workerSignal);
          const errMsg = publicErrorMessage(error);
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
    }, { signal: taskSignal });

    evalStore.finishEvalRun(evalRunId, "completed");
  } catch (error) {
    evalStore.finishEvalRun(evalRunId, "failed", publicErrorMessage(error));
    throw toPublicError(error);
  }

  return {
    evalRunId,
    resumed,
    suiteName: suite.name,
    candidate,
    modelId,
    historyMode,
    specHash: spec.hash,
    endpoint: spec.endpoint,
    totalItems: items.length,
    totalTurns,
    completedTurns,
    skippedExistingTurns,
    errorTurns,
    totalAgentCalls: evalStore.countAgentCalls(runRef, "candidate"),
  };
}
