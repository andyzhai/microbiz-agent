import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expenseSchema, validateExpense } from "./expense.js";
import type { ExpenseDraft } from "./expense.js";
import { findExpenseMatches, needsExpenseLookup } from "./expense-matches.js";
import { loadFixture } from "./fixtures.js";
import { getServiceIncidentEvidence, loadAlert, reportEvidence } from "./incident-fixtures.js";
import type { OperationsResult } from "./operations.js";
import { authorizeArtifact } from "./policy.js";
import { triageSchema, validateTriage } from "./triage.js";
import type { ExpenseResult } from "./workflow.js";

type ReviewedResult = ExpenseResult | OperationsResult;

export function serializeExpenseCsv(draft: ExpenseDraft): string {
  const fields = Object.keys(expenseSchema.shape) as (keyof ExpenseDraft)[];
  const header = fields.flatMap(field => [field, field + "Evidence"]);
  const cells = fields.flatMap(field => [draft[field].value, draft[field].evidence]);
  const row = cells.map(value => {
    let cell = String(value ?? "");
    if (/^[\t\r\n]|^\s*[=+@\-＝＋＠－]/u.test(cell)) cell = "'" + cell;
    return '"' + cell.replaceAll('"', '""') + '"';
  });
  return header.join(",") + "\r\n" + row.join(",") + "\r\n";
}

function operationsText(result: OperationsResult, source: NonNullable<ReturnType<typeof loadAlert>>) {
  const parsed = triageSchema.safeParse(result.report);
  if (!parsed.success || !isDeepStrictEqual(result.scope, source.scope)) return;
  const evidence = reportEvidence(getServiceIncidentEvidence.read(source));
  if (!isDeepStrictEqual(result.evidence, evidence)) return;
  const { report, issues } = validateTriage(parsed.data, evidence);
  if (issues.length) return;
  const words = (value: string) => value.replaceAll("_", " ");
  const { service, start, end } = source.scope;
  return [
    `Operations report for ${service} (${source.id})`, `Window: ${start} to ${end} (end exclusive)`,
    "", "Observations", ...report.observations.map(o => `- ${words(o.finding)} [${o.evidenceIds.join(", ")}]`),
    "", "Hypotheses", ...report.hypotheses.map(h => `- ${words(h.relationship)} (${h.certainty}) [${h.evidenceIds.join(", ")}]`),
    ...(report.hypotheses.length ? [] : ["None."]), "", "Next checks", ...report.nextChecks.map(c => "- " + words(c)),
    "", "Evidence", ...evidence.samples.map(s => `- ${s.id}  ${s.at}  error rate ${s.errorPercent}%`),
    ...evidence.deployments.map(d => `- ${d.id}  ${d.at}  deployment`), "",
  ].join("\n");
}

function previewArtifact(result: ReviewedResult) {
  if (result.status !== "completed" || result.issues.length || !result.fixtureId) return;
  let content: string | undefined;
  let extension: string;
  if (result.task === "expense-review") {
    const source = loadFixture(result.fixtureId);
    if (!source || !authorizeArtifact(result.task, source, result.classification)) return;
    const parsed = expenseSchema.safeParse(result.draft);
    if (!parsed.success || result.duplicateCandidates.length) return;
    if (needsExpenseLookup(source)) {
      const checked = result.tools.some(t => t.name === findExpenseMatches.name && t.outcome === "completed");
      if (!checked || findExpenseMatches.read(source).length) return;
    }
    const validated = validateExpense(parsed.data, source);
    if (validated.issues.length) return;
    content = serializeExpenseCsv(validated.draft);
    extension = "csv";
  } else {
    const source = loadAlert(result.fixtureId);
    if (!source || !authorizeArtifact(result.task, source, result.classification)) return;
    content = operationsText(result, source);
    extension = "txt";
  }
  if (!content) return;
  const root = fs.realpathSync.native(".");
  if (process.platform === "win32" && root.startsWith("\\\\")) return;
  const directory = join(root, ".microbiz", "artifacts");
  const destination = join(directory, result.fixtureId + "." + extension);
  if (dirname(destination) !== directory) return;
  return Object.freeze({ action: "exportReviewedArtifact" as const, task: result.task, fixtureId: result.fixtureId,
    destination, content, sha256: createHash("sha256").update(content).digest("hex") });
}

export type ArtifactPreview = NonNullable<ReturnType<typeof previewArtifact>>;
type ExportOutcome =
  | { status: "exported"; destination: string; sha256: string }
  | { status: "cancelled" }
  | { status: "blocked"; reason: "export_denied" | "review_changed" | "unsafe_directory" | "destination_exists" }
  | { status: "failed"; reason: "write_failed" | "possible_partial_write"; destination: string };

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

// Create and check each component separately so a link in the parent cannot
// redirect recursive mkdir. The leaf is opened exclusively, including on retry.
function isControlledDirectory(path: string) {
  return fs.lstatSync(path).isDirectory() && relative(path, fs.realpathSync.native(path)) === "";
}

function writeOnce(review: ArtifactPreview): ExportOutcome {
  const { destination, content, sha256 } = review;
  const directory = dirname(destination);
  let created = false;
  try {
    for (const path of [dirname(directory), directory]) {
      try {
        fs.mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      if (!isControlledDirectory(path)) return { status: "blocked", reason: "unsafe_directory" };
    }
    const fd = fs.openSync(destination, "wx", 0o600);
    created = true;
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      const current = fs.lstatSync(destination, { bigint: true });
      if (!isControlledDirectory(directory) || !current.isFile() || opened.nlink !== 1n ||
          opened.dev !== current.dev || opened.ino !== current.ino) throw new Error("Destination changed");
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { status: "exported", destination, sha256 };
  } catch (error) {
    if (!created && hasCode(error, "EEXIST")) return { status: "blocked", reason: "destination_exists" };
    return { status: "failed", reason: created ? "possible_partial_write" : "write_failed", destination };
  }
}

// Only the post-review CLI supplies confirm. This one-shot invocation is the
// approval scope. No approval value is accepted from a task, tool or saved file.
export async function exportReviewedArtifact(result: ReviewedResult,
  confirm: (preview: ArtifactPreview) => Promise<boolean>): Promise<ExportOutcome> {
  const review = previewArtifact(result);
  if (!review) return { status: "blocked", reason: "export_denied" };
  if (await confirm(review) !== true) return { status: "cancelled" };
  const current = previewArtifact(result);
  if (!current) return { status: "blocked", reason: "export_denied" };
  if (!isDeepStrictEqual(current, review)) return { status: "blocked", reason: "review_changed" };
  return writeOnce(review);
}
