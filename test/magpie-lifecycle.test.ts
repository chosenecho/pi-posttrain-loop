import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMagpieWebSearchRunner } from "../src/shared/web-search.js";
import { PublicError } from "../src/shared/public-error.js";

async function fixture(t: test.TestContext, extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "magpie-lifecycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "gateway.cjs");
  const events = join(dir, "starts.txt");
  const pids = join(dir, "pids.txt");
  await writeFile(script, `
    const { appendFileSync } = require('node:fs');
    const query = process.argv[process.argv.indexOf('--query') + 1];
    appendFileSync(${JSON.stringify(events)}, query + '\\n');
    appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ content: [{ type: 'text', text: query }], isError: query === 'error' }));
    }, query === 'slow' ? 250 : 20);
  `);
  const run = createMagpieWebSearchRunner({
    binPath: process.execPath, argsPrefix: [script], maxConcurrency: 1, timeoutMs: 3000,
    ...extra,
  });
  const starts = async () => (await readFile(events, "utf8")).trim().split("\n");
  const waitForStart = async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { return Number((await readFile(pids, "utf8")).trim().split("\n")[0]); }
      catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    throw new Error("fixture process did not start");
  };
  return { run, starts, waitForStart };
}

test("Magpie cancels a queued request without spawning its process", async (t) => {
  const { run, starts } = await fixture(t);
  const controller = new AbortController();
  const first = run({ query: "slow" });
  const queued = run({ query: "queued", signal: controller.signal });
  const rejected = assert.rejects(queued, (error: unknown) => error instanceof PublicError && error.code === "operation_aborted");
  controller.abort();
  await first;
  await rejected;
  assert.deepEqual(await starts(), ["slow"]);
});


test("identical Magpie requests have independent cancellation and cache only completed successes", async (t) => {
  const { run, starts, waitForStart } = await fixture(t);
  const controller = new AbortController();
  const first = run({ query: "slow", signal: controller.signal });
  const cancelled = assert.rejects(first, (error: unknown) => error instanceof PublicError && error.code === "operation_aborted");
  const pid = await waitForStart();
  const second = run({ query: "slow" });
  controller.abort();
  await cancelled;
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  assert.equal((await second).text, "slow");
  assert.equal((await run({ query: "SLOW" })).text, "slow");
  assert.deepEqual(await starts(), ["slow", "slow"]);
});

test("Magpie error responses are never cached", async (t) => {
  const { run, starts } = await fixture(t);
  assert.equal((await run({ query: "error" })).isError, true);
  assert.equal((await run({ query: "error" })).isError, true);
  assert.deepEqual(await starts(), ["error", "error"]);
});
