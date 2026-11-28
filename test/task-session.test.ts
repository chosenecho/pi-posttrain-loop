import { storeConnection } from "./fixtures/store-connection.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DataMakerStore } from "../src/synth/store/index.js";
import { TaskSession } from "../src/shared/task-store.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ReasoningStore } from "../src/reasoning/store.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dm-task-session-"));
  return { path: join(directory, "main.sqlite"), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

test("a live writer excludes another store before domain initialization while readers remain available", () => {
  const files = fixture();
  const writer = new DataMakerStore(files.path);
  try {
    const material = writer.upsertMaterial({ videoId: "exclusive", content: "kept" });
    assert.throws(() => new DataMakerStore(files.path), /database_busy/);
    assert.throws(() => new ReasoningStore(files.path), /database_busy/);
    assert.equal(writer.hasTable("reasoning_runs"), false);
    const reader = new DataMakerStore(files.path, { readOnly: true });
    try {
      assert.equal(reader.getMaterialSha256(material.id), material.sha256);
    } finally { reader.close(); }
  } finally { writer.close(); }
  try {
    const successor = new ReasoningStore(files.path);
    successor.close();
  } finally { files.dispose(); }
});

test("a killed writer is recovered by its successor, preserving runs started by that successor", { timeout: 15_000 }, async () => {
  const files = fixture();
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/task-writer.mts", import.meta.url)), files.path], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  try {
    const [message] = await once(child, "message") as [{ runId: number }];
    assert.throws(() => new DataMakerStore(files.path), /database_busy/);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const successor = new DataMakerStore(files.path);
    try {
      const ownRun = successor.createRun({ kind: "answer_judge", maxAttempts: 1, maxTurns: 1, config: {}, prompts: {}, skills: [], exportPolicy: {} });
      assert.equal(successor.markInterruptedRuns().runs, 1);
      assert.equal((storeConnection(successor).prepare("SELECT status FROM runs WHERE id = ?").get(message.runId) as {status:string}).status, "interrupted");
      assert.equal((storeConnection(successor).prepare("SELECT status FROM runs WHERE id = ?").get(ownRun) as {status:string}).status, "running");
    } finally { successor.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    files.dispose();
  }
});

test("an owner on an unknown host is never automatically taken over", () => {
  const files = fixture();
  const store = new DataMakerStore(files.path);
  store.close();
  const raw = new DatabaseSync(files.path);
  raw.prepare("INSERT INTO runtime_task_lock VALUES ('writer', 'foreign-token', 'other-host.invalid', 999999, 'foreign', '2026-01-01')").run();
  raw.close();
  try { assert.throws(() => new DataMakerStore(files.path), /database_busy/); }
  finally { files.dispose(); }
});

test("transaction rejects promises and rolls back writes before returning", () => {
  const store = new DataMakerStore(":memory:");
  try {
    assert.throws(() => store.transaction(() => {
      store.upsertMaterial({ videoId: "rollback", content: "temporary" });
      return Promise.resolve("invalid");
    }), /async_transaction/);
    let invoked = false;
    assert.throws(() => store.transaction(async () => { invoked = true; }), /async_transaction/);
    assert.equal(invoked, false);
    assert.equal(store.listAllMaterials().length, 0);
  } finally { store.close(); }
});

test("recovery never interrupts a run owned by the current writer", () => {
  const store = new DataMakerStore(":memory:");
  try {
    const runId = store.createRun({
      kind: "answer_judge", maxAttempts: 1, maxTurns: 1,
      config: {}, prompts: {}, skills: [], exportPolicy: {},
    });
    assert.deepEqual(store.markInterruptedRuns(), { runs: 0, runItems: 0, turns: 0, attempts: 0, modelCalls: 0 });
    assert.equal((storeConnection(store).prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status, "running");
  } finally { store.close(); }
});

test("a process cancellation keeps ownership until cleanup closes its session", { timeout: 15_000 }, async () => {
  const files = fixture();
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/task-signalled-writer.mts", import.meta.url)), files.path], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  try {
    await once(child, "message");
    const cancelled = once(child, "message");
    if (process.platform === "win32") child.send("interrupt");
    else child.kill("SIGTERM");
    assert.deepEqual((await cancelled)[0], { aborted: true });
    assert.throws(() => new DataMakerStore(files.path), /database_busy/);
    const exited = once(child, "exit");
    child.send("drained");
    await exited;
    const successor = new DataMakerStore(files.path);
    successor.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    files.dispose();
  }
});

test("a SQLite transaction blocking the claim reports the structured busy error", () => {
  const files = fixture();
  new DataMakerStore(files.path).close();
  const blocker = new DatabaseSync(files.path);
  blocker.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => new DataMakerStore(files.path, { busyTimeoutMs: 0 }), { code: "database_busy" });
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
    files.dispose();
  }
});

test("owner-loss release preserves the other owner and removes process signal listeners", () => {
  const db = new DatabaseSync(":memory:");
  const initialInterrupts = process.listenerCount("SIGINT");
  const initialTerminates = process.listenerCount("SIGTERM");
  const session = new TaskSession(db, "fixture");
  try {
    db.prepare("UPDATE runtime_task_lock SET owner_token = 'replacement'").run();
    assert.throws(() => session.release(), { code: "database_owner_lost" });
    assert.equal(db.prepare("SELECT owner_token FROM runtime_task_lock").get()?.owner_token, "replacement");
    assert.equal(session.signal.aborted, true);
    assert.equal(process.listenerCount("SIGINT"), initialInterrupts);
    assert.equal(process.listenerCount("SIGTERM"), initialTerminates);
  } finally { db.close(); }
});
