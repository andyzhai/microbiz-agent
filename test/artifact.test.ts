import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { exportReviewedArtifact, serializeExpenseCsv } from "../src/artifact.js";
import { runOperations } from "../src/operations.js";
import { runExpense } from "../src/workflow.js";

function workspace(t: TestContext) {
  const original = process.cwd();
  const root = fs.mkdtempSync(join(tmpdir(), "microbiz-export-"));
  process.chdir(root);
  t.after(() => {
    process.chdir(original);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const approve = async () => true;
const denied = { status: "blocked", reason: "export_denied" };

test("export checks unresolved findings, both domain validators and task provenance before prompting", async t => {
  const root = workspace(t);
  const expense = await runExpense("receipt-normal");
  expense.draft!.totalMinor.value = 999;
  const ops = await runOperations("alert-normal");
  ops.report!.hypotheses[0]!.certainty = "confirmed";
  const results = [expense, ops, await runExpense("receipt-incomplete"), await runExpense("receipt-duplicate"),
    await runOperations("alert-insufficient"), await runExpense("../receipt-normal")];
  for (const result of results) {
    assert.deepEqual(await exportReviewedArtifact(result, async () => assert.fail("unexpected prompt")), denied);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test("approval is bound to the reviewed content, task fixture, destination and current policy", async t => {
  const root = workspace(t);
  const result = await runExpense("receipt-normal");
  const changed = { status: "blocked", reason: "review_changed" };
  assert.deepEqual(await exportReviewedArtifact(result, async preview => {
    assert.ok(Object.isFrozen(preview));
    result.draft!.category.value = "other"; // Still domain-valid, but different reviewed bytes.
    return true;
  }), changed);
  assert.deepEqual(await exportReviewedArtifact(result, async () => {
    result.fixtureId = "receipt-injection"; // Same merchant and values, different task input.
    return true;
  }), changed);
  assert.deepEqual(await exportReviewedArtifact(result, async () => {
    result.classification = "internal";
    return true;
  }), denied);
  result.classification = "synthetic";
  fs.mkdirSync("elsewhere");
  assert.deepEqual(await exportReviewedArtifact(result, async () => {
    process.chdir("elsewhere");
    return true;
  }), changed);
  assert.deepEqual(fs.readdirSync("."), []);
  assert.deepEqual(fs.readdirSync(root), ["elsewhere"]);
});

test("CSV preserves quotes, commas and newlines and neutralizes spreadsheet formulas", async () => {
  const { draft } = await runExpense("receipt-normal");
  for (const prefix of ["=", "+", "-", "@", "  =", "\t", "\r", "\n"]) {
    draft!.merchant.value = prefix + 'a,"b"\nc';
    assert.ok(serializeExpenseCsv(draft!).includes(`"'${prefix}a,""b""\nc","L1"`));
  }
});

test("linked parent, linked output directory, and existing destination cannot redirect or overwrite", async t => {
  const root = workspace(t);
  const result = await runExpense("receipt-normal");
  const outside = join(root, "other");
  fs.mkdirSync(outside);
  const storage = join(root, ".microbiz");
  const artifacts = join(storage, "artifacts");
  for (const path of [storage, artifacts]) {
    fs.symlinkSync(outside, path, "junction");
    assert.deepEqual(await exportReviewedArtifact(result, approve), { status: "blocked", reason: "unsafe_directory" });
    fs.unlinkSync(path);
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.mkdirSync(path);
  }
  const original = join(outside, "keep.csv");
  fs.writeFileSync(original, "original");
  fs.linkSync(original, join(artifacts, "receipt-normal.csv"));
  assert.deepEqual(await exportReviewedArtifact(result, approve), { status: "blocked", reason: "destination_exists" });
  assert.equal(fs.readFileSync(original, "utf8"), "original");
});

test("a partial write is reported once and a subsequent approval cannot overwrite it", async t => {
  workspace(t);
  const result = await runExpense("receipt-normal");
  const write = t.mock.method(fs, "writeFileSync", (fd: number) => {
    fs.writeSync(fd, "partial");
    throw new Error("simulated disk full");
  });
  const outcome = await exportReviewedArtifact(result, approve);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.reason, "possible_partial_write");
  assert.equal(fs.readFileSync(outcome.destination, "utf8"), "partial");
  assert.deepEqual(await exportReviewedArtifact(result, approve), { status: "blocked", reason: "destination_exists" });
  assert.equal(write.mock.callCount(), 1);
});
