import { DataMakerStore } from "../../src/synth/store/index.js";
const store = new DataMakerStore(process.argv[2]!);
const runId = store.createRun({ kind: "answer_judge", maxAttempts: 1, maxTurns: 1, config: {}, prompts: {}, skills: [], exportPolicy: {} });
process.send?.({ runId });
// IPC keeps the fixture live while the parent checks writer exclusion, then terminates it.
process.on("message", () => undefined);
