import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { runObjective } from "../src/coordinator.js";
import { expenseSchema } from "../src/expense.js";
import { fakeModel } from "../src/fake-model.js";
import { loadFixture } from "../src/fixtures.js";
import { AdapterError, createGateway } from "../src/gateway.js";
import type { ModelAdapter } from "../src/gateway.js";
import { loadAlert } from "../src/incident-fixtures.js";
import { incidentLookup, propose } from "../src/profiles.js";

function runWith(generate: ModelAdapter["generate"], maxAttempts = 4) {
  return runObjective("daily-review", () => createGateway({ ...fakeModel, generate }, { maxAttempts }));
}

test("daily review runs the two specialists in order and retains their typed evidence", async () => {
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  const result = await runWith(async (req, signal) => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    const source = req.sources[0]!;
    assert.equal(req.sources.length, 1);
    if (req.exchange) assert.equal(req.exchange.source, source);
    calls.push(source.id);
    return fakeModel.generate(req, signal);
  });
  assert.equal(peak, 1);
  assert.deepEqual(calls, ["receipt-normal", "alert-normal", "alert-normal"]);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.budget, { used: 3, limit: 4 });
  const [expense, ops] = result.children;
  assert.ok(expense && "draft" in expense);
  assert.ok(ops && "report" in ops);
  assert.deepEqual(expense.draft?.totalMinor, { value: 1250, evidence: "L4" });
  assert.match(result.briefing[0]!.headline, /CAD 12\.50.*L4/);
  assert.deepEqual(ops.report?.hypotheses[0]?.evidenceIds, ["alert-normal-s1", "alert-normal-s2", "alert-normal-d1"]);
  assert.match(result.briefing[1]!.headline, /checkout.*0\.2%.*6\.8%/);
  assert.deepEqual(result.children.map(s => [s.status, s.classification, s.decisions.map(d => d.attempts)]),
    [["completed", "synthetic", [1]], ["completed", "synthetic", [2, 3]]]);
});

for (const task of ["expense-review", "operations-triage"] as const) {
  test(`daily review retains the other result when ${task} fails`, async () => {
    const result = await runWith(async (req, signal) => {
      if (req.instruction.task === task) throw new Error("private provider detail");
      return fakeModel.generate(req, signal);
    });
    assert.equal(result.status, "failed");
    const failed = result.children.find(section => section.task === task);
    assert.equal(failed?.status, "failed");
    assert.equal(failed.decisions.at(-1)?.reason, "adapter_failed");
    const completed = result.children.find(section => section.task !== task);
    assert.equal(completed?.status, "completed");
    if (task === "expense-review") {
      assert.ok("report" in completed && completed.report?.observations[0]?.evidenceIds.includes("alert-normal-s1"));
    } else {
      assert.ok("draft" in completed && completed.draft?.totalMinor.evidence === "L4");
    }
    assert.doesNotMatch(JSON.stringify(result), /private provider detail/);
  });
}

test("the parent cap stops before the next child or its follow-up, preserving work already performed", async () => {
  for (const limit of [1, 2]) {
    let calls = 0;
    const result = await runWith((req, signal) => { calls++; return fakeModel.generate(req, signal); }, limit);
    assert.equal(calls, limit);
    assert.deepEqual(result.budget, { used: limit, limit });
    assert.equal(result.status, "blocked");
    assert.equal(result.children[0]?.status, "completed");
    const ops = result.children[1];
    assert.equal(ops?.status, "blocked");
    if (limit === 1) {
      assert.deepEqual(ops.decisions, []);
      assert.deepEqual(ops.issues, [{ code: "attempt_budget_exhausted" }]);
    } else {
      assert.equal(ops.decisions.at(-1)?.reason, "attempt_budget_exhausted");
      assert.ok("evidence" in ops && ops.evidence?.samples.length === 2);
    }
  }
});

test("the briefing propagates review status and only summarizes validated fields", async () => {
  const result = await runWith(async (req, signal) => {
    const output = await fakeModel.generate(req, signal);
    if (req.instruction.task !== "expense-review") return output;
    return { ...expenseSchema.parse(output), merchant: { value: "restricted merchant text", evidence: "L1" } };
  });
  assert.equal(result.status, "needs_review");
  assert.deepEqual(result.briefing.map(s => s.status), ["needs_review", "completed"]);
  assert.doesNotMatch(JSON.stringify(result), /restricted merchant text/);
});

test("a rate limit on the first child halts dispatch with parent capacity remaining", async () => {
  const result = await runWith(async () => { throw new AdapterError("rate_limited"); });
  assert.deepEqual(result.budget, { used: 1, limit: 4 });
  assert.deepEqual(result.children.map(s => s.status), ["failed", "blocked"]);
  assert.deepEqual(result.children[1]?.issues, [{ code: "rate_limited" }]);
});

test("delegated access denies other registered inputs and enforces child and parent reservations", async () => {
  const receipt = loadFixture("receipt-normal")!;
  const other = loadFixture("receipt-duplicate")!;
  const gateway = createGateway(fakeModel, { maxAttempts: 2 });
  const child = gateway.forTask("expense-review", receipt, 1);
  for (const request of [
    { instruction: propose, sources: [other] },
    { instruction: propose, sources: [receipt, other] },
    { instruction: incidentLookup, sources: [loadAlert("alert-normal")!] },
  ]) assert.equal((await child.generate(request, z.unknown())).decision.reason, "source_denied");
  assert.equal(gateway.budget.used, 0);
  const generate = () => child.generate({ instruction: propose, sources: [receipt] }, z.unknown());
  const pair = await Promise.all([generate(), generate()]);
  assert.deepEqual(pair.map(r => r.status), ["completed", "blocked"]);
  const sibling = gateway.forTask("expense-review", other, 2);
  const req = { instruction: propose, sources: [other] };
  assert.equal((await sibling.generate(req, z.unknown())).status, "completed");
  assert.equal((await sibling.generate(req, z.unknown())).decision.reason, "attempt_budget_exhausted");
  assert.equal(gateway.budget.used, 2);
});

test("unsupported objectives and attempts to delegate through a child cannot start another task", async () => {
  const denied = await runObjective("private objective", () => assert.fail("gateway should not be constructed"));
  assert.equal(denied.status, "blocked");
  assert.deepEqual(denied.briefing, []);
  assert.doesNotMatch(JSON.stringify(denied), /private objective/);
  const result = await runWith(async (req, signal) => req.instruction.task === "expense-review"
    ? { name: "runObjective", arguments: { objective: "private objective" } } : fakeModel.generate(req, signal));
  assert.deepEqual(result.children.map(s => s.status), ["blocked", "completed"]);
  assert.deepEqual(result.children[0]?.issues, [{ code: "tool_denied" }]);
  assert.doesNotMatch(JSON.stringify(result), /private objective|runObjective/);
});
