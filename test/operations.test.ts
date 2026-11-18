import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { fakeModel } from "../src/fake-model.js";
import { loadFixture } from "../src/fixtures.js";
import { createGateway } from "../src/gateway.js";
import { evidenceSchema, getServiceIncidentEvidence, loadAlert } from "../src/incident-fixtures.js";
import { runOperations } from "../src/operations.js";
import { authorize, OFFLINE_DESTINATION } from "../src/policy.js";
import { incidentFinish, incidentLookup, propose } from "../src/profiles.js";
import { createExecutor } from "../src/tools.js";
import { proposeTriage, validateTriage } from "../src/triage.js";
import type { TriageReport } from "../src/triage.js";
import { runExpense } from "../src/workflow.js";
import { evaluateOperations } from "./evaluate-operations.js";

test("triage cites the changed error rate and deployment, and separates sparse evidence from a cause", async () => {
  const normal = await runOperations("alert-normal");
  assert.equal(normal.status, "completed");
  assert.deepEqual(normal.report?.hypotheses, [{ relationship: "deployment_may_be_related_to_increase", certainty: "possible",
    evidenceIds: ["alert-normal-s1", "alert-normal-s2", "alert-normal-d1"] }]);
  assert.deepEqual(normal.evidence?.samples.map(s => s.errorPercent), [0.2, 6.8]);
  assert.deepEqual(normal.decisions.map(d => [d.location, d.attempts]), [["offline", 1], ["offline", 2]]);
  const sparse = await runOperations("alert-insufficient");
  assert.equal(sparse.status, "needs_review");
  assert.deepEqual(sparse.report?.missingInformation, ["need_comparison_sample"]);
  assert.deepEqual(sparse.report?.hypotheses, []);
  assert.deepEqual(sparse.report?.nextChecks, ["inspect_health_history"]);
});

test("the executor and egress policy bind service, half-open window, tool and exchange to the selected task", async () => {
  const source = loadAlert("incident-07")!;
  const name = getServiceIncidentEvidence.name;
  const args = source.scope;
  const call = { name, arguments: args };
  const execute = createExecutor("operations-triage", source, [name]);
  for (const change of [{ service: "checkout" }, { start: args.end }, { end: "2099-01-01T00:00:00Z" },
    { url: "https://example.invalid" }, { dataset: "demo-prior-expenses" }, { location: "external" }]) {
    assert.equal(execute({ name, arguments: { ...args, ...change } }).error, "tool_arguments_denied");
  }
  const read = execute(call);
  assert.deepEqual(read.evidence?.deployments, []); // The fixture contains a deployment exactly at the exclusive end.
  assert.ok(read.exchange);
  assert.ok(execute(call).exchange);
  assert.equal(execute(call).error, "tool_budget_exhausted");
  const receipt = loadFixture("receipt-normal")!;
  assert.equal(createExecutor("operations-triage", receipt, [name])(call).error, "tool_denied");
  assert.equal(createExecutor("operations-triage", { ...source }, [name])(call).error, "tool_denied");
  assert.equal(createExecutor("operations-triage", source, [])(call).error, "tool_denied");
  for (const request of [
    { instruction: propose, sources: [source] }, { instruction: incidentFinish, sources: [receipt] },
    { instruction: incidentLookup, sources: [source, loadAlert("incident-02")!] },
    { instruction: incidentFinish, sources: [source] }, { instruction: incidentLookup, sources: [source], exchange: read.exchange },
    { instruction: incidentFinish, sources: [loadAlert("incident-02")!], exchange: read.exchange },
    { instruction: incidentFinish, sources: [source], exchange: { ...read.exchange } },
  ]) assert.equal(authorize(request, OFFLINE_DESTINATION), "source_denied");
  const never = () => { throw new Error("Unexpected gateway construction"); };
  assert.equal((await runExpense(source.id, never)).status, "blocked");
  assert.equal((await runOperations(receipt.id, never)).status, "blocked");
});

test("instruction-bearing evidence cannot add tools, choose a destination or trigger a third model call", async () => {
  for (const name of ["shell", "findExpenseMatches", "changeProvider"]) {
    let calls = 0;
    const result = await runOperations("alert-injection", { destination: OFFLINE_DESTINATION, async generate(req, signal) {
      calls++;
      if (!req.exchange) return fakeModel.generate(req, signal);
      assert.match(req.exchange.resultJson, /shell command/);
      return { name, arguments: { location: "external" } };
    } });
    assert.equal(calls, 2);
    assert.equal(result.status, "failed");
    assert.equal(result.decisions.at(-1)?.reason, "invalid_output");
    assert.ok(result.decisions.every(d => d.location === "offline"));
    assert.deepEqual(result.tools, [{ name: getServiceIncidentEvidence.name, outcome: "completed" }]);
    assert.doesNotMatch(JSON.stringify(result), /shell command|private ledger/);
  }
  const denied = await runOperations("alert-injection", { destination: OFFLINE_DESTINATION,
    generate: async () => ({ name: "findExpenseMatches", arguments: {} }) });
  assert.equal(denied.status, "blocked");
  assert.deepEqual(denied.tools, [{ name: "unregistered", outcome: "blocked" }]);
  assert.equal(denied.decisions.length, 1);
});

test("invalid citations, inverted trends, unsupported causes and invented gaps are withheld for review", async () => {
  const result = await runOperations("alert-normal", { destination: OFFLINE_DESTINATION, async generate(req, signal) {
    if (!req.exchange) return fakeModel.generate(req, signal);
    return { observations: [
      { finding: "error_rate_decreased", evidenceIds: ["alert-normal-s1", "alert-normal-s2"] },
      { finding: "deployment_recorded", evidenceIds: ["incident-01-d1"] }],
      hypotheses: [{ relationship: "deployment_may_be_related_to_increase", certainty: "confirmed",
        evidenceIds: ["alert-normal-s1", "alert-normal-s2", "alert-normal-d1"] }],
      missingInformation: ["no_health_samples"], nextChecks: [] };
  } });
  assert.equal(result.status, "needs_review");
  assert.deepEqual(result.report, { observations: [], hypotheses: [], missingInformation: [], nextChecks: [] });
  assert.deepEqual(result.issues.map(i => i.code), ["unsupported_observation", "unsupported_observation",
    "unsupported_causal_assertion", "incorrect_evidence_gap", "missing_health_comparison", "missing_next_check"]);
});

test("repeated triage findings and checks retain their first occurrence and distinct citations", () => {
  const evidence = getServiceIncidentEvidence.read(loadAlert("alert-normal")!);
  const firstEvent = evidence.deployments[0]!;
  evidence.deployments.push({ ...firstEvent, id: "alert-normal-d2" });
  const expected = proposeTriage(evidence);
  const [trend, firstDeployment, secondDeployment] = expected.observations;
  const [firstHypothesis, secondHypothesis] = expected.hypotheses;
  assert.ok(trend && firstDeployment && secondDeployment && firstHypothesis && secondHypothesis);
  const proposed: TriageReport = { ...expected,
    observations: [trend, firstDeployment, structuredClone(trend), secondDeployment],
    hypotheses: [firstHypothesis, secondHypothesis, structuredClone(firstHypothesis)],
    nextChecks: ["compare_deployment_changes", "inspect_sampled_requests", "compare_deployment_changes"],
  };
  assert.deepEqual(validateTriage(proposed, evidence), { report: expected, issues: [] });

  proposed.observations.unshift({ ...trend, evidenceIds: [...trend.evidenceIds].reverse() });
  proposed.hypotheses.unshift({ ...firstHypothesis, certainty: "confirmed" });
  proposed.missingInformation = ["need_comparison_sample", "need_comparison_sample"];
  assert.deepEqual(validateTriage(proposed, evidence), { report: expected, issues: [
    { code: "unsupported_observation" }, { code: "unsupported_causal_assertion" },
    { code: "incorrect_evidence_gap", claimed: ["need_comparison_sample"], expected: [] },
  ] });
});

test("triage compares distinct missing-information claims against the retrieved evidence", () => {
  const evidence = getServiceIncidentEvidence.read(loadAlert("alert-insufficient")!);
  const expected = proposeTriage(evidence);
  const comparison = "need_comparison_sample";
  const insufficient = { code: "insufficient_evidence" };
  assert.deepEqual(validateTriage({ ...expected, missingInformation: [comparison, comparison] }, evidence),
    { report: expected, issues: [insufficient] });
  const cases: TriageReport["missingInformation"][] = [[], ["no_health_samples"], [comparison, "no_health_samples"]];
  for (const claimed of cases) {
    const result = validateTriage({ ...expected, missingInformation: claimed }, evidence);
    assert.deepEqual(result.report.missingInformation, [comparison]);
    assert.deepEqual(result.issues, [insufficient, { code: "incorrect_evidence_gap", claimed, expected: [comparison] }]);
  }
});

test("failed evidence read, provider timeout and exhausted follow-up budget end the run explicitly", async t => {
  const broken = t.mock.method(evidenceSchema, "safeParse", () => { throw new Error("private lookup error"); });
  const failed = await runOperations("alert-normal");
  broken.mock.restore();
  assert.equal(failed.status, "failed");
  assert.equal(failed.issues[0]?.code, "invalid_tool_result");
  assert.equal(failed.decisions.length, 1);
  assert.equal(failed.evidence, null);
  assert.doesNotMatch(JSON.stringify(failed), /private lookup error/);
  const hung = mock.fn(async () => new Promise<never>(() => {}));
  const timeout = await runOperations("alert-normal", () => createGateway({ destination: OFFLINE_DESTINATION, generate: hung },
    { timeoutMs: 15, maxAttempts: 1 }));
  assert.equal(hung.mock.callCount(), 1);
  assert.equal(timeout.status, "failed");
  assert.equal(timeout.decisions.at(-1)?.reason, "request_timeout");
  const exhausted = await runOperations("alert-normal", () => createGateway(fakeModel, { maxAttempts: 1 }));
  assert.equal(exhausted.status, "blocked");
  assert.equal(exhausted.decisions.at(-1)?.reason, "attempt_budget_exhausted");
  assert.equal(exhausted.tools[0]?.outcome, "completed");
  assert.equal(exhausted.report, null);
});

test("valid IDs alone cannot support a hypothesis for a late or distant deployment", async () => {
  for (const id of ["incident-04", "incident-08"]) {
    const result = await runOperations(id, { destination: OFFLINE_DESTINATION, async generate(req, signal) {
      if (!req.exchange) return fakeModel.generate(req, signal);
      return { observations: [{ finding: "error_rate_increased", evidenceIds: [id + "-s1", id + "-s2"] }],
        hypotheses: [{ relationship: "deployment_may_be_related_to_increase", certainty: "possible",
          evidenceIds: [id + "-s1", id + "-s2", id + "-d1"] }], missingInformation: [], nextChecks: ["inspect_sampled_requests"] };
    } });
    assert.equal(result.status, "needs_review");
    assert.deepEqual(result.report?.hypotheses, []);
    assert.deepEqual(result.issues, [{ code: "unsupported_hypothesis" }]);
  }
});

test("held-out rubric counts missed findings, rejected claims, inappropriate checks and unavailable reports", async () => {
  const { scores } = await evaluateOperations();
  assert.equal(scores.cases, 8);
  assert.equal(scores.nextCheckPass, 8);
  assert.equal(scores.uncertaintyPass, 8);
  assert.ok(scores.findingsCovered >= scores.annotatedFindings * 0.8);
  assert.ok(scores.supportedClaims >= scores.factualClaims * 0.9);
  const wrong = await evaluateOperations({ destination: OFFLINE_DESTINATION, async generate(req, signal) {
    if (!req.exchange) return fakeModel.generate(req, signal);
    if (req.sources[0]!.id === "incident-08") throw new Error("unavailable");
    return { observations: [{ finding: "deployment_recorded", evidenceIds: ["wrong"] }],
      hypotheses: [{ relationship: "deployment_may_be_related_to_increase", certainty: "confirmed", evidenceIds: ["s1", "s2", "d1"] }],
      missingInformation: [], nextChecks: [] };
  } });
  assert.equal(wrong.scores.reports, 7);
  assert.equal(wrong.scores.annotatedFindings, scores.annotatedFindings);
  assert.equal(wrong.scores.factualClaims, 7);
  assert.equal(wrong.scores.findingsCovered, 0);
  assert.equal(wrong.scores.supportedClaims, 0);
  assert.equal(wrong.scores.unsupportedCausalAssertions, 7);
  assert.equal(wrong.scores.nextCheckPass, 0);
  assert.equal(wrong.scores.uncertaintyPass, 0);
});
