import { DataMakerStore } from "../../src/synth/store/index.js";

const store = new DataMakerStore(process.argv[2]!);
store.signal!.addEventListener("abort", () => process.send?.({ aborted: true }), { once: true });
process.on("message", (message) => {
  if (message === "interrupt") process.emit("SIGTERM", "SIGTERM");
  if (message === "drained") {
    store.close();
    process.disconnect?.();
  }
});
process.send?.({ ready: true });
