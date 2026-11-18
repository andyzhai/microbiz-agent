import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { manageReview, startReview } from "../src/durable-review.js";
import { withReviewStore } from "../src/review-store.js";
import { runExpense } from "../src/workflow.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const guard = fileURLToPath(new URL("./deny-network.cjs", import.meta.url));
const faults = new URL("./crash-review.mjs", import.meta.url).href;
const noPrompt = async () => assert.fail("unexpected approval prompt");

function workspace(t: TestContext, enter = false) {
  const cwd = fs.mkdtempSync(join(tmpdir(), "microbiz-recovery-"));
  const original = process.cwd();
  if (enter) process.chdir(cwd);
  t.after(() => {
    if (enter) process.chdir(original);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return cwd;
}
function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--require", guard, cli, ...args], { cwd, encoding: "utf8", timeout: 15_000 });
}
function parseLast(stdout: string) { return JSON.parse(stdout.trim().split("\n").at(-1)!); }
function pause(cwd: string, fixture: string) {
  const child = run(cwd, "--review", fixture);
  assert.equal(child.status, 2, child.stderr);
  const saved = parseLast(child.stdout);
  assert.equal(saved.status, "awaiting_approval");
  return saved as { runId: string; destination: string; sha256: string };
}
async function prompt(cwd: string, runId: string, crashPoint?: string) {
  const child = spawn(process.execPath, ["--require", guard, ...(crashPoint ? ["--import", faults] : []), cli, "--resume", runId], {
    cwd, timeout: 20_000, env: { ...process.env, MICROBIZ_TEST_CRASH: crashPoint ?? "" },
  });
  let stdout = "";
  let stderr = "";
  const closed = once(child, "close");
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const phrase = await Promise.race([
    new Promise<string>(resolve => child.stdout.setEncoding("utf8").on("data", chunk => {
      stdout += chunk;
      const match = /Type "(approve [a-f0-9]+)"/.exec(stdout);
      if (match) resolve(match[1]!);
    })),
    closed.then(() => { throw new Error("Exited before prompt: " + stderr + stdout); }),
  ]);
  return { child, phrase, closed, stderr: () => stderr };
}

for (const point of ["approved", "partial-stage", "published"]) {
  test("built CLI resumes after process death at " + point, async t => {
    const cwd = workspace(t);
    const saved = pause(cwd, point === "published" ? "alert-normal" : "receipt-normal");
    const { runId, destination } = saved;
    const interrupted = await prompt(cwd, runId, point);
    interrupted.child.stdin.end(interrupted.phrase + "\n");
    await interrupted.closed;
    assert.equal(interrupted.stderr(), "crash at " + point);
    const inspection = run(cwd, "--inspect", runId);
    assert.equal(inspection.status, 0, inspection.stderr);
    assert.equal(parseLast(inspection.stdout).status, point === "approved" ? "approved" : "exporting");
    assert.equal(fs.existsSync(destination), point === "published");
    if (point === "partial-stage")
      assert.equal(fs.readFileSync(join(cwd, ".microbiz", "reviews", runId + ".tmp"), "utf8"), "merchan");
    const resumed = run(cwd, "--resume", runId);
    assert.equal(resumed.status, 0, resumed.stderr);
    const { receipt } = parseLast(resumed.stdout);
    assert.equal(receipt.outcome, point === "published" ? "reconciled" : "created");
    assert.equal(createHash("sha256").update(fs.readFileSync(destination)).digest("hex"), saved.sha256);
    const original = fs.statSync(destination, { bigint: true });
    const replay = run(cwd, "--resume", runId);
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(parseLast(replay.stdout).receipt, receipt);
    assert.equal(fs.statSync(destination, { bigint: true }).mtimeNs, original.mtimeNs);
    assert.deepEqual(fs.readdirSync(join(cwd, ".microbiz", "reviews")), [runId + ".sqlite"]);
    assert.equal(run(cwd, "--cleanup", runId).status, 0);
    assert.equal(fs.existsSync(destination), true);
    assert.equal(JSON.parse(run(cwd, "--resume", runId).stderr).reason, "run_not_found");
  });
}

test("a competing process is refused and killing the operator at the prompt leaves a cancellable review", async t => {
  const cwd = workspace(t);
  const saved = pause(cwd, "receipt-injection");
  const interrupted = await prompt(cwd, saved.runId);
  try {
    const competing = run(cwd, "--cancel", saved.runId);
    assert.equal(competing.status, 1);
    assert.equal(JSON.parse(competing.stderr).reason, "run_busy");
  } finally {
    interrupted.child.kill("SIGKILL");
    await interrupted.closed;
  }
  assert.equal(parseLast(run(cwd, "--inspect", saved.runId).stdout).status, "awaiting_approval");
  assert.equal(JSON.parse(run(cwd, "--cleanup", saved.runId).stderr).reason, "run_still_active");
  assert.equal(parseLast(run(cwd, "--cancel", saved.runId).stdout).status, "cancelled");
  assert.equal(run(cwd, "--resume", saved.runId).status, 2);
  const other = pause(cwd, "alert-normal");
  assert.equal(run(cwd, "--cleanup", saved.runId).status, 0);
  assert.deepEqual(fs.readdirSync(join(cwd, ".microbiz", "reviews")), [other.runId + ".sqlite"]);
  assert.equal(fs.existsSync(saved.destination), false);
});

test("expired permission is cleared and a fresh decision is required", async t => {
  const cwd = workspace(t, true);
  const saved = await startReview(await runExpense("receipt-normal"));
  const interrupted = await prompt(cwd, saved.runId, "approved");
  interrupted.child.stdin.end(interrupted.phrase + "\n");
  await interrupted.closed;
  const state = parseLast(run(cwd, "--inspect", saved.runId).stdout);
  const clock = t.mock.method(Date, "now", () => state.approval.expiresAt);
  await assert.rejects(manageReview("--resume", saved.runId, noPrompt), /approval_expired/);
  clock.mock.restore();
  assert.equal(fs.existsSync(saved.destination), false);
  const cancelled = await manageReview("--resume", saved.runId, async () => false);
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await manageReview("--inspect", saved.runId, noPrompt)).status, "cancelled");
});

test("matching files reconcile, conflicting or missing files are never replaced on replay", async t => {
  workspace(t, true);
  const result = await runExpense("receipt-normal");
  const first = await startReview(result);
  await manageReview("--resume", first.runId, async () => true);
  const second = await startReview(result);
  const matching = await manageReview("--resume", second.runId, async () => true);
  assert.ok("receipt" in matching && matching.receipt.outcome === "reconciled");
  const third = await startReview(result);
  fs.writeFileSync(first.destination, "other");
  for (const id of [first.runId, third.runId])
    await assert.rejects(manageReview("--resume", id, async () => true), /destination_conflict/);
  assert.equal(fs.readFileSync(first.destination, "utf8"), "other");
  assert.equal((await manageReview("--cancel", third.runId, noPrompt)).status, "cancelled");
  fs.unlinkSync(first.destination);
  await assert.rejects(manageReview("--resume", first.runId, noPrompt), /recorded_artifact_missing/);
  assert.equal(fs.existsSync(first.destination), false);
});

test("changed draft or policy, copied approval, unsupported version and corrupt storage fail closed", async t => {
  const cwd = workspace(t, true);
  const result = await runExpense("receipt-normal");
  const approved = await startReview(result);
  const interrupted = await prompt(cwd, approved.runId, "approved");
  interrupted.child.stdin.end(interrupted.phrase + "\n");
  await interrupted.closed;
  const original = await withReviewStore(approved.runId, false, store => store.read()) as {
    result: typeof result; identity: { policyVersion: number }; progress: unknown };
  const stale = structuredClone(original);
  stale.result.draft!.category.value = "other";
  await withReviewStore(approved.runId, false, store => store.save(stale));
  await assert.rejects(manageReview("--resume", approved.runId, noPrompt), /review_changed/);
  assert.equal((await manageReview("--inspect", approved.runId, noPrompt)).status, "invalidated");
  for (const change of ["draft", "policy", "approval", "version", "malformed"]) {
    const saved = await startReview(result);
    const modified = { ...structuredClone(original), runId: saved.runId, version: 1 };
    if (change !== "approval") modified.progress = { status: "awaiting_approval" };
    if (change === "draft") modified.result.draft!.category.value = "other";
    if (change === "policy") modified.identity.policyVersion = 0;
    if (change === "version") modified.version = 2;
    await withReviewStore(saved.runId, false, store => store.save(change === "malformed" ? {} : modified));
    const error = { draft: /review_changed/, policy: /review_changed/, approval: /invalid_approval/,
      version: /unsupported_checkpoint_version/, malformed: /invalid_checkpoint/ }[change]!;
    await assert.rejects(manageReview("--resume", saved.runId, noPrompt), error);
    assert.equal(fs.existsSync(saved.destination), false);
  }
  const path = join(cwd, ".microbiz", "reviews", approved.runId + ".sqlite");
  fs.writeFileSync(path, "invalid database");
  await assert.rejects(manageReview("--resume", approved.runId, noPrompt), /invalid_checkpoint/);
  await assert.rejects(manageReview("--cleanup", "../reviews", noPrompt), /invalid_run_id/);
});

test("durable export refuses linked storage and a matching externally linked destination", async t => {
  const cwd = workspace(t, true);
  const saved = await startReview(await runExpense("receipt-normal"));
  const directory = join(cwd, ".microbiz");
  const other = join(cwd, "other");
  fs.mkdirSync(other);
  const outputDir = join(directory, "artifacts");
  fs.symlinkSync(other, outputDir, "junction");
  let content = "";
  await assert.rejects(manageReview("--resume", saved.runId, async p => {
    content = p.content;
    return true;
  }), /unsafe_directory/);
  assert.deepEqual(fs.readdirSync(other), []);
  fs.unlinkSync(outputDir);
  fs.mkdirSync(outputDir);
  const external = join(other, "keep");
  fs.writeFileSync(external, content);
  fs.linkSync(external, saved.destination);
  await assert.rejects(manageReview("--resume", saved.runId, noPrompt), /destination_conflict/);
  const journal = join(directory, "reviews", saved.runId + ".sqlite-journal");
  fs.linkSync(external, journal);
  await assert.rejects(manageReview("--cancel", saved.runId, noPrompt), /unsafe_checkpoint/);
  assert.equal(fs.readFileSync(external, "utf8"), content);
});
