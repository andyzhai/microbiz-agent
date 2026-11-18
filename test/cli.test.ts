import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const guard = fileURLToPath(new URL("./deny-network.cjs", import.meta.url));

test("built export CLI requires a fresh response and saves exactly the reviewed bytes for each specialist", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "microbiz-export-cli-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  async function review(id: string, answer: (phrase: string) => string) {
    const child = spawn(process.execPath, ["--require", guard, cli, "--export", id], { cwd, timeout: 10_000 });
    let stdout = "";
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
    child.stdout.setEncoding("utf8").on("data", chunk => {
      stdout += chunk;
      const prompt = /Type "(approve [a-f0-9]+)" to create/.exec(stdout);
      if (prompt && !child.stdin.writableEnded) child.stdin.end(answer(prompt[1]!));
    });
    const [status] = await once(child, "close");
    assert.equal(stderr, "");
    return { status, stdout, outcome: JSON.parse(stdout.trimEnd().split("\n").at(-1)!) };
  }
  let previous = "";
  const cancelled = await review("receipt-injection", phrase => {
    previous = phrase;
    return "reject\n";
  });
  assert.equal(cancelled.status, 2);
  assert.equal(cancelled.outcome.status, "cancelled");
  assert.equal((await review("receipt-injection", () => previous + "\n")).outcome.status, "cancelled");
  assert.equal((await review("receipt-normal", () => "")).outcome.status, "cancelled");
  const unresolved = await review("receipt-incomplete", () => assert.fail("unexpected prompt"));
  assert.equal(unresolved.status, 2);
  assert.equal(unresolved.outcome.reason, "export_denied");
  assert.deepEqual(readdirSync(cwd), []);
  for (const [id, suffix] of [["receipt-normal", "csv"], ["alert-normal", "txt"]] as const) {
    const runs = await Promise.all([review(id, phrase => phrase + "\n"), review(id, phrase => phrase + "\n")]);
    const saved = runs.find(run => run.status === 0);
    const conflict = runs.find(run => run.status === 1);
    assert.ok(saved && conflict);
    assert.equal(conflict.outcome.reason, "destination_exists");
    assert.equal(saved.status, 0);
    assert.equal(saved.outcome.status, "exported");
    assert.equal(saved.outcome.destination, join(realpathSync.native(cwd), ".microbiz", "artifacts", id + "." + suffix));
    const bytes = readFileSync(saved.outcome.destination);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), saved.outcome.sha256);
    const preview = saved.stdout.split("--- begin file ---\n")[1]!.split("--- end file ---")[0];
    assert.equal(bytes.toString("utf8"), preview);
    assert.match(preview!, id === "receipt-normal" ? /"1250","L4"/ : /alert-normal-s2.*error rate 6.8%/);
  }
});

test("built CLI runs without credentials or network, saves no state, and reruns after process exit", () => {
  const cwd = mkdtempSync(join(tmpdir(), "microbiz-m0-"));
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/OPENROUTER|OPENAI|LANGCHAIN|LANGSMITH|API_KEY|TOKEN|NODE_OPTIONS/i.test(key)) delete env[key];
    }
    // A global tracing setting must not turn an offline run into an upload.
    env.LANGSMITH_TRACING = "true";
    env.LANGCHAIN_TRACING_V2 = "true";
    const run = (...args: string[]) => spawnSync(process.execPath, ["--require", guard, cli, ...args], {
      cwd, env, encoding: "utf8", timeout: 10_000,
    });
    for (const id of ["receipt-normal", "receipt-incomplete"]) {
      const first = run(id);
      const second = run(id);
      assert.equal(first.error, undefined);
      assert.equal(second.error, undefined);
      assert.equal(first.status, id === "receipt-normal" ? 0 : 2, first.stderr);
      assert.equal(second.status, first.status, second.stderr);
      assert.equal(first.stderr, "");
      assert.equal(second.stderr, "");
      const a = JSON.parse(first.stdout);
      const b = JSON.parse(second.stdout);
      assert.equal(a.status, id === "receipt-normal" ? "completed" : "needs_review");
      assert.deepEqual(a.draft, b.draft);
      assert.deepEqual(a.issues, b.issues);
      assert.equal(a.decisions[0].attempts, 1);
      assert.equal(b.decisions[0].attempts, 1);
    }
    const duplicate = run("receipt-duplicate");
    assert.equal(duplicate.status, 2);
    assert.equal(JSON.parse(duplicate.stdout).duplicateCandidates[0].id, "prior-017");
    for (const [id, status] of [["alert-normal", 0], ["alert-insufficient", 2]] as const) {
      const alert = run(id);
      assert.equal(alert.stderr, "");
      assert.equal(alert.status, status);
      assert.equal(JSON.parse(alert.stdout).task, "operations-triage");
    }
    const daily = run("--objective", "daily-review");
    const partial = run("--objective", "daily-review", "--simulate-expense-failure");
    const restarted = run("--objective", "daily-review");
    assert.equal(daily.status, 0, daily.stderr);
    assert.equal(partial.status, 1, partial.stderr);
    assert.equal(restarted.status, 0, restarted.stderr);
    for (const output of [daily, partial, restarted]) assert.equal(output.stderr, "");
    assert.deepEqual(JSON.parse(partial.stdout).briefing.map((s: { status: string }) => s.status), ["failed", "completed"]);
    assert.deepEqual(JSON.parse(restarted.stdout).budget, { used: 3, limit: 4 });
    assert.deepEqual(JSON.parse(daily.stdout).briefing.map((s: { headline: string }) => s.headline),
      JSON.parse(restarted.stdout).briefing.map((s: { headline: string }) => s.headline));
    const unsupported = run("--objective", "private-objective");
    assert.equal(unsupported.status, 1);
    assert.equal(JSON.parse(unsupported.stdout).issues[0].code, "unsupported_objective");
    assert.doesNotMatch(unsupported.stdout, /private-objective/);
    const missingKey = run("--live", "receipt-normal");
    assert.equal(missingKey.status, 1);
    assert.equal(JSON.parse(missingKey.stderr).issues[0].code, "missing_openrouter_key");
    env.OPENROUTER_API_KEY = "dummy-key";
    const deniedLive = run("--live", "arbitrary-secret-input");
    assert.equal(deniedLive.status, 1);
    assert.equal(deniedLive.stderr, "");
    assert.equal(JSON.parse(deniedLive.stdout).status, "blocked");
    assert.doesNotMatch(deniedLive.stdout, /dummy-key|arbitrary-secret-input/);
    const unknown = run("secret-unknown-id");
    assert.equal(unknown.status, 1);
    assert.equal(JSON.parse(unknown.stdout).status, "blocked");
    assert.doesNotMatch(unknown.stdout, /secret-unknown-id/);
    assert.equal(run("receipt-normal", "--classification=synthetic").status, 1);
    assert.equal(run("--resume").status, 1);
    assert.equal(run("--help").status, 0);
    assert.equal(run().status, 1);
    assert.deepEqual(readdirSync(cwd), []);
  } finally {
    assert.equal(dirname(resolve(cwd)), resolve(tmpdir()));
    assert.ok(basename(cwd).startsWith("microbiz-m0-"));
    rmSync(cwd, { recursive: true, force: true });
  }
});
