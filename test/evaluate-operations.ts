import { runOperations } from "../src/operations.js";
import type { OperationsResult } from "../src/operations.js";
import type { GatewayConfig } from "../src/task.js";
import type { TriageReport } from "../src/triage.js";

type Finding = TriageReport["observations"][number]["finding"];
interface Annotation {
  health: Finding | null;
  deployment: boolean;
  association: boolean;
  gap: TriageReport["missingInformation"][number] | null;
  check: TriageReport["nextChecks"][number];
}
// Independently specified expectations. s1/s2 are the earlier/later samples and d1 the deployment.
const annotations: Record<string, Annotation> = {
  "incident-01": { health: "error_rate_increased", deployment: true, association: true, gap: null, check: "compare_deployment_changes" },
  "incident-02": { health: "error_rate_decreased", deployment: false, association: false, gap: null, check: "inspect_sampled_requests" },
  "incident-03": { health: "error_rate_unchanged", deployment: true, association: false, gap: null, check: "inspect_sampled_requests" },
  "incident-04": { health: "error_rate_increased", deployment: true, association: false, gap: null, check: "inspect_sampled_requests" },
  "incident-05": { health: "health_sample", deployment: true, association: false, gap: "need_comparison_sample", check: "inspect_health_history" },
  "incident-06": { health: null, deployment: true, association: false, gap: "no_health_samples", check: "inspect_health_history" },
  "incident-07": { health: "error_rate_increased", deployment: false, association: false, gap: null, check: "inspect_sampled_requests" },
  "incident-08": { health: "error_rate_increased", deployment: true, association: false, gap: null, check: "inspect_sampled_requests" },
};
function scoreCase(id: string, expected: Annotation, result: OperationsResult) {
  const s1 = id + "-s1", s2 = id + "-s2", d1 = id + "-d1";
  const keyFacts = new Set<string>();
  if (expected.health) keyFacts.add([expected.health, s1, ...(expected.health === "health_sample" ? [] : [s2])].join("/"));
  if (expected.deployment) keyFacts.add(["deployment_recorded", d1].join("/"));
  const supportedFacts = new Set(keyFacts);
  if (expected.health) supportedFacts.add("health_sample/" + s1);
  if (expected.health?.startsWith("error_rate_")) supportedFacts.add("health_sample/" + s2);

  const report = result.report;
  const facts = (report?.observations ?? []).map(o => [o.finding, ...o.evidenceIds].join("/"));
  const rejected = (code: string) => result.issues.filter(i => i.code === code).length;
  const associations = report?.hypotheses ?? [];
  const supportedAssociation = expected.association && associations.some(h =>
    h.certainty === "possible" && h.evidenceIds.join("/") === [s1, s2, d1].join("/"));
  const uncertainty = report && !rejected("incorrect_evidence_gap") && !rejected("unsupported_hypothesis") &&
    !rejected("unsupported_causal_assertion") && (expected.gap ? result.status === "needs_review" &&
      report.missingInformation.includes(expected.gap) : !report.missingInformation.length) &&
    (expected.association ? supportedAssociation : !associations.length);
  return {
    annotatedFindings: keyFacts.size + Number(expected.association),
    findingsCovered: [...keyFacts].filter(f => facts.includes(f)).length + Number(supportedAssociation),
    factualClaims: facts.length + rejected("unsupported_observation"),
    supportedClaims: facts.filter(f => supportedFacts.has(f)).length,
    unsupportedCausalAssertions: rejected("unsupported_causal_assertion"),
    nextCheckPass: Number(!!report?.nextChecks.includes(expected.check) &&
      (expected.deployment || !report.nextChecks.includes("compare_deployment_changes"))),
    uncertaintyPass: Number(!!uncertainty),
  };
}

export async function evaluateOperations(config?: GatewayConfig) {
  const scores = { cases: 0, reports: 0, annotatedFindings: 0, findingsCovered: 0, factualClaims: 0, supportedClaims: 0,
    unsupportedCausalAssertions: 0, nextCheckPass: 0, uncertaintyPass: 0 };
  const outcomes = [];
  for (const [id, expected] of Object.entries(annotations)) {
    const result = await runOperations(id, config);
    scores.cases++;
    if (result.report) scores.reports++;
    const score = scoreCase(id, expected, result);
    for (const key of Object.keys(score) as (keyof typeof score)[]) scores[key] += score[key];
    outcomes.push({ id, status: result.status, reason: result.decisions.at(-1)?.reason, ...score });
    if (result.decisions.some(d => d.reason === "rate_limited")) break;
  }
  return { scores, outcomes };
}
if (import.meta.main) {
  if (process.argv.length > 2) throw new Error("Usage: npm run evaluate:operations");
  const result = await evaluateOperations();
  console.log(JSON.stringify({ mode: "offline baseline", model: "fake-v1", ...result }, null, 2));
  if (result.scores.reports !== result.scores.cases) process.exitCode = 1;
}
