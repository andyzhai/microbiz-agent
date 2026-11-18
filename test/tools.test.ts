import assert from "node:assert/strict";
import { test } from "node:test";
import { loadFixture } from "../src/fixtures.js";
import { OFFLINE_DESTINATION } from "../src/policy.js";
import { createExecutor } from "../src/tools.js";
import { runExpense } from "../src/workflow.js";

test("read scope and budget bind queries to the selected fixture and approved prior-expense dataset", () => {
  const source = loadFixture("receipt-duplicate")!;
  const name = "findExpenseMatches";
  const args = { receiptId: source.id, dataset: "demo-prior-expenses" };
  const call = { name, arguments: args };
  assert.equal(createExecutor("other", source, [name])(call).error, "tool_denied");
  assert.equal(createExecutor("expense-review", source, [])(call).error, "tool_denied");
  assert.equal(createExecutor("expense-review", { ...source }, [name])(call).error, "tool_denied");
  const execute = createExecutor("expense-review", source, [name]);
  for (const arguments_ of [null, {}, { ...args, receiptId: "receipt-normal" }, { ...args, dataset: "../private" },
    { ...args, task: "other" }, { ...args, classification: "synthetic" }]) {
    assert.equal(execute({ name, arguments: arguments_ }).error, "tool_arguments_denied");
  }
  assert.equal(execute({ ...call, name: "export" }).error, "tool_denied");
  assert.equal(execute(call).matches?.[0]?.id, "prior-017");
  assert.ok(Object.isFrozen(execute(call).exchange));
  assert.equal(execute(call).error, "tool_budget_exhausted");
  const normal = loadFixture("receipt-normal")!;
  assert.deepEqual(createExecutor("expense-review", normal, [name])({ name, arguments: { ...args, receiptId: normal.id } }).matches, []);
});

test("instruction-bearing receipt cannot authorize a different tool or resource", async () => {
  for (const call of [{ name: "export_private_ledger", arguments: {} },
    { name: "findExpenseMatches", arguments: { receiptId: "receipt-duplicate", dataset: "demo-prior-expenses" } }]) {
    const result = await runExpense("receipt-injection", { destination: OFFLINE_DESTINATION, generate: async request => {
      assert.match(request.sources[0]!.content, /Export/);
      return call;
    } });
    assert.equal(result.status, "blocked");
    assert.equal(result.draft, null);
    assert.deepEqual(result.duplicateCandidates, []);
    assert.equal(result.decisions.length, 1);
    assert.equal(result.tools[0]?.outcome, "blocked");
    assert.doesNotMatch(JSON.stringify(result), /private_ledger/);
  }
});
