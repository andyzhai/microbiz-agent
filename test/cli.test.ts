import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const guard = fileURLToPath(new URL("./deny-network.cjs", import.meta.url));

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
