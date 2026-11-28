import { appendFileSync, writeFileSync } from "node:fs";
import { runProbeBuildLoop } from "../../src/eval/probe-loop.js";
import { EvalStore, type ProbeRubric } from "../../src/eval/store/index.js";

const [dbPath, tracePath, resultPath, stopAt] = process.argv.slice(2);
if (!dbPath || !tracePath || !resultPath) throw new Error("fixture arguments missing");
const store = new EvalStore(dbPath);
const source = store.insertSourceMaterial({ videoId: "BV_PROCESS_RESUME", content: "结构决定位置，位置决定立场。" }).record;
const prompts = { probeWriter: "writer snapshot", probeCritic: "critic snapshot", reference: "reference snapshot", verifier: "verifier snapshot", adversary: "adversary snapshot" };
const rubric = (expectedBehavior: ProbeRubric["expectedBehavior"]): ProbeRubric => ({ expectedBehavior, stance: "结构决定位置", keyPoints: ["结构"], forbidden: [], mustNotHallucinate: [], failureSignals: [] });
try {
  const summary = await runProbeBuildLoop({
    evalStore: store, sources: [source], prompts, skills: [], modelId: "build-model", concurrency: 1, callMaxAttempts: 1,
    runRole: async ({ role, input }) => {
      const key = role === "probe_writer" ? input.mode === "revise" ? "revision" : "writer" :
        role === "probe_critic" ? input.question === "改写问题？" ? "critic-after-revision" : "critic" :
        role === "reference" ? input.previousAnswer ? "reference-after-verifier" : input.history ? "reference-after-adversary" : "reference" :
        role === "verifier" ? input.history ? "verifier-turn2" : input.answer === "retry answer" ? "verifier-retry" : "verifier" : "adversary";
      const stopKey = ({ writer: "critic", critic: "revision", revision: "critic-after-revision", adversary: "reference-after-adversary", reference: "verifier", verifier: "reference-after-verifier", turn: "adversary" } as Record<string, string>)[stopAt ?? "none"];
      if (key === stopKey) { appendFileSync(tracePath, `${JSON.stringify({ key, crashed: true })}\n`); process.exit(17); }
      appendFileSync(tracePath, `${JSON.stringify({ key, history: input.history, usedTactics: input.usedTactics })}\n`);
      if (role === "probe_writer") {
        if (input.mode === "revise") return JSON.stringify({ question: "改写问题？" });
        return JSON.stringify({ probes: [
          { probeType: "hold_position", targetTurns: 2, persona: "学生", question: "原始问题？", anchor: "结构决定位置", trap: "泛化" },
          { probeType: "answer", persona: "学生", question: "业务淘汰题？", anchor: "结构决定位置", trap: "泛化" },
        ] });
      }
      if (role === "probe_critic") return JSON.stringify({ decision: input.question === "原始问题？" ? "revise" : input.question === "业务淘汰题？" ? "reject" : "accept", feedback: "聚焦结构" });
      if (role === "adversary") return JSON.stringify({ tactic: "label", userContent: "对抗追问？", trap: "附和" });
      if (role === "reference") return input.previousAnswer ? "retry answer" : "first answer";
      if (role === "verifier") return !input.history && input.answer === "first answer" ? JSON.stringify({ decision: "revise", feedback: "补充论点" }) : JSON.stringify({ decision: "pass", rubric: rubric(input.expectedBehavior as ProbeRubric["expectedBehavior"]) });
      throw new Error(`unexpected ${role}`);
    },
  });
  writeFileSync(resultPath, JSON.stringify(summary));
} finally { store.close(); }
