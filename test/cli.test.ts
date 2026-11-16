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
