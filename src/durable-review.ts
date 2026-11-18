import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { previewArtifact } from "./artifact.js";
import type { ArtifactPreview, ReviewedResult } from "./artifact.js";
import { expenseSchema } from "./expense.js";
import { loadFixture } from "./fixtures.js";
import { evidenceSchema, incidentScopeSchema, loadAlert } from "./incident-fixtures.js";
import { artifactPolicyVersion } from "./policy.js";
import { discardStage, finalizeOutput, outputMatches } from "./review-output.js";
import { ReviewError, withReviewStore } from "./review-store.js";
import { triageSchema } from "./triage.js";

// Only the fields used for artifact validation enter the review checkpoint.
const completed = { fixtureId: z.string(), status: z.literal("completed"),
  classification: z.literal("synthetic"), issues: z.array(z.never()).max(0) };
const reviewed = z.discriminatedUnion("task", [
  z.object({ ...completed, task: z.literal("expense-review"), draft: expenseSchema,
    duplicateCandidates: z.array(z.never()).max(0),
    tools: z.array(z.object({ name: z.literal("findExpenseMatches"), outcome: z.literal("completed") })) }),
  z.object({ ...completed, task: z.literal("operations-triage"), report: triageSchema,
    scope: incidentScopeSchema, evidence: evidenceSchema,
    tools: z.array(z.object({ name: z.literal("getServiceIncidentEvidence"), outcome: z.literal("completed") })) }),
]);
const digest = z.hash("sha256");
const identitySchema = z.strictObject({ action: z.literal("exportReviewedArtifact"), task: z.string(),
  fixtureId: z.string(), destination: z.string(), sha256: digest, draftVersion: digest, policyVersion: z.int() });
const approvalSchema = z.strictObject({ binding: digest, approvedAt: z.int(), expiresAt: z.int() });
const receiptSchema = z.strictObject({ destination: z.string(), sha256: digest, recordedAt: z.int(),
  outcome: z.enum(["created", "reconciled"]) });
const progressSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("awaiting_approval") }),
  z.strictObject({ status: z.literal("cancelled") }),
  z.strictObject({ status: z.literal("invalidated") }),
  z.strictObject({ status: z.enum(["approved", "exporting"]), approval: approvalSchema }),
  z.strictObject({ status: z.literal("exported"), approval: approvalSchema, receipt: receiptSchema }),
]);
const checkpointSchema = z.strictObject({ version: z.literal(1), runId: z.uuidv4(), result: reviewed,
  identity: identitySchema, progress: progressSchema });
type Checkpoint = z.infer<typeof checkpointSchema>;
type Progress = Checkpoint["progress"];
type Confirm = (review: ArtifactPreview) => Promise<boolean>;
export type ReviewCommand = "--inspect" | "--resume" | "--cancel" | "--cleanup";
export const approvalMinutes = 15;
const approvalLifetime = approvalMinutes * 60_000;

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function identityFor(result: Checkpoint["result"], preview: ArtifactPreview) {
  const source = result.task === "expense-review" ? loadFixture(result.fixtureId) : loadAlert(result.fixtureId);
  return { action: preview.action, task: preview.task, fixtureId: preview.fixtureId, destination: preview.destination,
    sha256: preview.sha256, draftVersion: hash([result, source?.content]), policyVersion: artifactPolicyVersion };
}
function binding(state: Checkpoint, approvedAt: number, expiresAt: number) {
  return hash([state.version, state.runId, state.identity, approvedAt, expiresAt]);
}
function readCheckpoint(raw: unknown, runId: string) {
  if (typeof raw === "object" && raw && "version" in raw && raw.version !== 1)
    throw new ReviewError("unsupported_checkpoint_version");
  const parsed = checkpointSchema.safeParse(raw);
  if (!parsed.success || parsed.data.runId !== runId) throw new ReviewError("invalid_checkpoint");
  const state = parsed.data;
  const progress = state.progress;
  if ("approval" in progress) {
    const { approvedAt, expiresAt } = progress.approval;
    if (progress.approval.binding !== binding(state, approvedAt, expiresAt) || expiresAt - approvedAt !== approvalLifetime)
      throw new ReviewError("invalid_approval");
  }
  if (progress.status === "exported" && (progress.receipt.destination !== state.identity.destination ||
      progress.receipt.sha256 !== state.identity.sha256)) throw new ReviewError("invalid_receipt");
  return state;
}

export async function startReview(result: ReviewedResult) {
  const preview = previewArtifact(result);
  const parsed = reviewed.safeParse(result);
  if (!preview || !parsed.success) throw new ReviewError("export_denied");
  const runId = randomUUID();
  const state: Checkpoint = { version: 1, runId, result: parsed.data, identity: identityFor(parsed.data, preview),
    progress: { status: "awaiting_approval" } };
  await withReviewStore(runId, true, store => store.save(state));
  return { runId, ...state.progress, destination: preview.destination, sha256: preview.sha256 };
}

export async function manageReview(command: ReviewCommand, runId: string, confirm: Confirm) {
  return withReviewStore(runId, false, async store => {
    const state = readCheckpoint(await store.read(), runId);
    let progress = state.progress;
    async function save(next: Progress) {
      await store.save({ ...state, progress: next });
      return { runId, ...next };
    }
    if (command === "--inspect") return { runId, ...progress, identity: state.identity, result: state.result };
    if (command === "--cleanup") {
      if (progress.status !== "exported" && progress.status !== "cancelled" && progress.status !== "invalidated")
        throw new ReviewError("run_still_active");
      discardStage(store.stage);
      store.removeAfterClose();
      return { runId, status: "cleaned" };
    }
    if (progress.status === "invalidated") throw new ReviewError("review_changed");
    if (progress.status === "cancelled") return { runId, ...progress };
    discardStage(store.stage);
    if (command === "--cancel" && (progress.status === "awaiting_approval" || progress.status === "approved"))
      return save({ status: "cancelled" });

    function currentPreview() {
      const preview = previewArtifact(state.result);
      if (!preview || !isDeepStrictEqual(identityFor(state.result, preview), state.identity))
        throw new ReviewError("review_changed");
      return preview;
    }
    let preview: ArtifactPreview;
    try {
      preview = currentPreview();
    } catch (error) {
      if (progress.status !== "exported") await save({ status: "invalidated" });
      throw error;
    }
    if (progress.status === "exported") {
      if (!outputMatches(preview)) throw new ReviewError("recorded_artifact_missing");
      return { runId, ...progress };
    }
    if (progress.status === "awaiting_approval") {
      if (await confirm(preview) !== true) return save({ status: "cancelled" });
      currentPreview();
      const approvedAt = Date.now();
      const expiresAt = approvedAt + approvalLifetime;
      progress = { status: "approved", approval: { binding: binding(state, approvedAt, expiresAt), approvedAt, expiresAt } };
      await save(progress);
    }
    const approval = progress.approval;
    function requireApproval() {
      const now = Date.now();
      if (now < approval.approvedAt || now >= approval.expiresAt) throw new ReviewError("approval_expired");
      currentPreview();
    }
    function receipt(outcome: "created" | "reconciled") {
      return save({ status: "exported", approval, receipt: { outcome, recordedAt: Date.now(),
        destination: preview.destination, sha256: preview.sha256 } });
    }
    // The previous process may have published the file and died before recording its receipt.
    if (progress.status === "exporting") {
      try {
        if (outputMatches(preview)) return receipt("reconciled");
      } catch (error) {
        if (command !== "--cancel" || !(error instanceof ReviewError) || error.message !== "destination_conflict") throw error;
      }
      if (command === "--cancel") return save({ status: "cancelled" });
    }
    try {
      requireApproval();
      if (progress.status === "approved") await save({ status: "exporting", approval });
      if (outputMatches(preview)) return receipt("reconciled");
      return receipt(finalizeOutput(preview, store.stage, requireApproval));
    } catch (error) {
      if (error instanceof ReviewError && error.message === "approval_expired") await save({ status: "awaiting_approval" });
      throw error;
    }
  });
}
