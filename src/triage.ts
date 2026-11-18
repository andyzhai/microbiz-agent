import { z } from "zod";
import type { IncidentEvidence } from "./incident-fixtures.js";

const finding = z.enum(["error_rate_increased", "error_rate_decreased", "error_rate_unchanged", "health_sample", "deployment_recorded"]);
const observation = z.strictObject({ finding, evidenceIds: z.array(z.string().min(1).max(64)).min(1).max(2) });
const hypothesis = z.strictObject({ relationship: z.literal("deployment_may_be_related_to_increase"),
  certainty: z.enum(["possible", "confirmed"]), evidenceIds: z.array(z.string().min(1).max(64)).length(3) });
const gap = z.enum(["no_health_samples", "need_comparison_sample"]);
const check = z.enum(["inspect_health_history", "compare_deployment_changes", "inspect_sampled_requests"]);
export const triageSchema = z.strictObject({ observations: z.array(observation).max(12), hypotheses: z.array(hypothesis).max(4),
  missingInformation: z.array(gap).max(2), nextChecks: z.array(check).max(3) });
export type TriageReport = z.infer<typeof triageSchema>;
type Sample = IncidentEvidence["samples"][number];
type Observation = TriageReport["observations"][number];

function trend(first: Sample, last: Sample): Observation["finding"] {
  if (last.errorPercent > first.errorPercent) return "error_rate_increased";
  return last.errorPercent < first.errorPercent ? "error_rate_decreased" : "error_rate_unchanged";
}
function nearby(first: Sample, last: Sample, at: string) {
  return first.at < at && at <= last.at && Date.parse(last.at) - Date.parse(at) <= 10 * 60_000;
}
function gaps(evidence: IncidentEvidence): TriageReport["missingInformation"] {
  if (!evidence.samples.length) return ["no_health_samples"];
  return evidence.samples.length === 1 ? ["need_comparison_sample"] : [];
}

// Offline baseline reads only the returned observations, never case IDs or evaluation annotations.
export function proposeTriage(evidence: IncidentEvidence): TriageReport {
  const first = evidence.samples.at(0);
  const last = evidence.samples.at(-1);
  const report: TriageReport = { observations: [], hypotheses: [], missingInformation: gaps(evidence),
    nextChecks: [evidence.samples.length < 2 ? "inspect_health_history" : "inspect_sampled_requests"] };
  if (first && last) {
    report.observations.push(first === last ? { finding: "health_sample", evidenceIds: [first.id] } :
      { finding: trend(first, last), evidenceIds: [first.id, last.id] });
  }
  for (const event of evidence.deployments) {
    report.observations.push({ finding: "deployment_recorded", evidenceIds: [event.id] });
    if (first && last && last.errorPercent > first.errorPercent && nearby(first, last, event.at)) {
      report.hypotheses.push({ relationship: "deployment_may_be_related_to_increase", certainty: "possible",
        evidenceIds: [first.id, last.id, event.id] });
      report.nextChecks = ["compare_deployment_changes", "inspect_sampled_requests"];
    }
  }
  return report;
}

export function validateTriage(proposed: TriageReport, evidence: IncidentEvidence) {
  const samples = new Map(evidence.samples.map(row => [row.id, row]));
  const events = new Map(evidence.deployments.map(row => [row.id, row]));
  const observations = proposed.observations.filter(({ finding, evidenceIds: ids }) => {
    const first = samples.get(ids[0]!);
    if (finding === "deployment_recorded") return ids.length === 1 && events.has(ids[0]!);
    if (finding === "health_sample") return ids.length === 1 && !!first;
    const last = samples.get(ids[1]!);
    return first && last && first.at < last.at && trend(first, last) === finding;
  });
  const hypotheses = proposed.hypotheses.filter(({ certainty, evidenceIds: [before, after, deploy] }) => {
    const first = samples.get(before!);
    const last = samples.get(after!);
    const event = events.get(deploy!);
    return certainty === "possible" && first && last && event && last.errorPercent > first.errorPercent && nearby(first, last, event.at);
  });
  const issues: { code: string }[] = [];
  for (const claim of proposed.observations) {
    if (!observations.includes(claim)) issues.push({ code: "unsupported_observation" });
  }
  for (const claim of proposed.hypotheses) {
    if (!hypotheses.includes(claim)) issues.push({ code: claim.certainty === "confirmed" ? "unsupported_causal_assertion" : "unsupported_hypothesis" });
  }
  const missingInformation = gaps(evidence);
  if (missingInformation.length) issues.push({ code: "insufficient_evidence" });
  if (proposed.missingInformation.length !== missingInformation.length ||
      missingInformation.some(missing => !proposed.missingInformation.includes(missing))) issues.push({ code: "incorrect_evidence_gap" });
  if (evidence.samples.length >= 2 && !observations.some(o => o.finding.startsWith("error_rate_")))
    issues.push({ code: "missing_health_comparison" });
  if (!proposed.nextChecks.length) issues.push({ code: "missing_next_check" });
  return { report: { observations, hypotheses, missingInformation, nextChecks: proposed.nextChecks }, issues };
}
