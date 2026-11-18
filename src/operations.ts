import "./offline.js";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { z } from "zod";
import { fakeModel } from "./fake-model.js";
import type { GatewayResult } from "./gateway.js";
import { getServiceIncidentEvidence, loadAlert, reportEvidence } from "./incident-fixtures.js";
import type { IncidentEvidence, IncidentScope } from "./incident-fixtures.js";
import { incidentFinish, incidentLookup } from "./profiles.js";
import { taskGateway } from "./task.js";
import type { GatewayConfig, TaskResult } from "./task.js";
import { createExecutor, toolProposalSchema } from "./tools.js";
import { triageSchema, validateTriage } from "./triage.js";
import type { TriageIssue, TriageReport } from "./triage.js";

export interface OperationsResult extends TaskResult {
  task: "operations-triage";
  scope: IncidentScope | null;
  report: TriageReport | null;
  evidence: IncidentEvidence | null;
  issues: readonly TriageIssue[];
  tools: readonly { name: "getServiceIncidentEvidence" | "unregistered"; outcome: "completed" | "blocked" | "failed" }[];
}

export async function runOperations(fixtureId: string, config: GatewayConfig = fakeModel,
  grants: readonly string[] = [getServiceIncidentEvidence.name]): Promise<OperationsResult> {
  const task = "operations-triage";
  const source = loadAlert(fixtureId);
  const base = { task, report: null, scope: null, evidence: null, tools: [], decisions: [] } as const;
  if (!source) return { ...base, fixtureId: null, classification: "unknown", status: "blocked", issues: [{ code: "unknown_fixture" }] };

  const gateway = taskGateway(config);
  const initial = { ...base, fixtureId: source.id, classification: source.classification,
    scope: source.scope, decisions: gateway.decisions };
  const execute = createExecutor(task, source, grants);
  const State = Annotation.Root({
    proposal: Annotation<GatewayResult<z.infer<typeof toolProposalSchema>>>(),
    result: Annotation<OperationsResult>(),
  });
  const graph = new StateGraph(State)
    .addNode("requestEvidence", async () => ({
      proposal: await gateway.generate({ instruction: incidentLookup, sources: [source] }, toolProposalSchema),
    }))
    .addNode("reviewEvidence", async ({ proposal }): Promise<{ result: OperationsResult }> => {
      if (proposal.status !== "completed") return { result: { ...initial, status: proposal.status, issues: [{ code: "model_request_failed" }] } };
      const read = execute(proposal.value);
      if (read.error) {
        const status = read.error === "invalid_tool_result" ? "failed" : "blocked";
        const name = proposal.value.name === getServiceIncidentEvidence.name ? getServiceIncidentEvidence.name : "unregistered";
        return { result: { ...initial, status, tools: [{ name, outcome: status }], issues: [{ code: read.error }] } };
      }
      const result = { ...initial, evidence: reportEvidence(read.evidence),
        tools: [{ name: getServiceIncidentEvidence.name, outcome: "completed" }] } as const;
      const final = await gateway.generate({ instruction: incidentFinish, sources: [source], exchange: read.exchange }, triageSchema);
      if (final.status !== "completed") return { result: { ...result, status: final.status, issues: [{ code: "model_request_failed" }] } };
      const validated = validateTriage(final.value, read.evidence);
      return { result: { ...result, ...validated, status: validated.issues.length ? "needs_review" : "completed" } };
    })
    .addEdge(START, "requestEvidence").addEdge("requestEvidence", "reviewEvidence").addEdge("reviewEvidence", END).compile();
  return (await graph.invoke({}, { recursionLimit: 4, callbacks: [] })).result;
}
