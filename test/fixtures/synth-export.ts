import { DataMakerStore } from "../../src/synth/store/index.js";
import type { ToolStep } from "../../src/shared/types.js";

/** Small public-store fixture captured before the export-policy extraction. */
export function populateSynthExportFixture(store: DataMakerStore): void {
  const questions: number[] = [];
  for (const [videoId, split] of [
    ["BV_ORACLE_A/P001", "train"], ["BV_ORACLE_A/P002", "train"],
    ["BV_ORACLE_B", "train"], ["BV_ORACLE_C", "train"],
    ["BV_ORACLE_TEST", "test"], ["BV_ORACLE_DPO", "dpo"],
  ] as const) {
    store.assignVideoSplit({ videoKey: videoId, split, method: "manual" });
    const material = store.upsertMaterial({ videoId, content: `原文 ${videoId}` });
    questions.push(store.insertQuestion({ materialId: material.id, question: `问题 ${questions.length + 1}` }).record.id);
  }
  const addResult = (runId: number, questionId: number, text: string, multiTurn = false, steps: ToolStep[] = []) => {
    const itemId = store.createRunItems(runId, [questionId]).get(questionId)!;
    store.startRunItem(itemId);
    for (let turnNo = 1; turnNo <= (multiTurn ? 2 : 1); turnNo++) {
      const turnId = store.createTurn({ runItemId: itemId, turnNo, ...(turnNo > 1 ? { userContent: "固定追问" } : {}) });
      const attemptId = store.startAttempt({ turnId, attemptNo: 1 });
      const answerCall = store.startModelCall({ runId, role: "answer", turnId, attemptId, inputRefs: {} });
      const answer = `${text}/${turnNo}`;
      store.finishModelCall(answerCall, answer);
      store.recordAttemptAnswer(attemptId, answer);
      if (turnNo === 1 && steps.length) store.recordAttemptToolSteps(attemptId, steps);
      const judgeCall = store.startModelCall({ runId, role: "judge", turnId, attemptId, inputRefs: {} });
      store.commitJudgeOutcome({
        runItemId: itemId, turnId, turnNo, attemptId, judgeCallId: judgeCall,
        judgeOutputText: '{"decision":"pass","issues":[],"feedback":""}',
        review: { decision: "pass", issues: [], feedback: "" },
        isFinalTurn: !multiTurn || turnNo === 2, exhaustedBudget: false,
      });
    }
  };
  const createRun = (training: boolean, profile: string, split?: string) => store.createRun({
    kind: "answer_judge", maxAttempts: 1, maxTurns: 2,
    config: { profile }, prompts: {}, skills: [],
    exportPolicy: { format: "messages_jsonl", training_enabled: training, ...(split ? { split, eval_enabled: true } : {}) },
  });
  const informal = createRun(false, "standard");
  addResult(informal, questions[0]!, "非正式");
  store.finishRun(informal, "completed");
  const old = createRun(true, "standard");
  addResult(old, questions[0]!, "旧正式");
  store.finishRun(old, "completed");
  const formal = createRun(true, "standard");
  for (let i = 0; i < 4; i++) {
    addResult(formal, questions[i]!, `正式${i + 1}`, i === 0 || i === 2, i === 0 ? [{
      stepNo: 1, toolName: "web_search", arguments: { query: "固定检索" }, toolOutput: "固定来源", preCallThought: "先查原始来源",
    }] : []);
  }
  store.finishRun(formal, "completed");
  const testRun = createRun(false, "todo", "test");
  addResult(testRun, questions[4]!, "测试");
  store.finishRun(testRun, "completed");
  const dpo = createRun(false, "clarify", "dpo");
  addResult(dpo, questions[5]!, "偏好");
  store.finishRun(dpo, "completed");
}
