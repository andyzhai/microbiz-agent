import { z } from "zod";
import type { Source } from "./policy.js";

const evidence = z.enum(["L1", "L2", "L3", "L4"]).nullable();
const textField = (value: z.ZodType<string>) => z.strictObject({ value: value.nullable(), evidence });
export const expenseSchema = z.strictObject({
  merchant: textField(z.string().min(1).max(100)),
  date: textField(z.iso.date()),
  currency: textField(z.literal("CAD")),
  totalMinor: z.strictObject({ value: z.number().int().min(0).max(100_000_000).nullable(), evidence }),
});
export type ExpenseDraft = z.infer<typeof expenseSchema>;
export type ExpenseField = keyof ExpenseDraft;
export interface ReviewIssue {
  readonly code: "missing_value" | "unsupported_value";
  readonly field: ExpenseField;
}

const labels: Record<ExpenseField, string> = {
  merchant: "Merchant", date: "Date", currency: "Currency", totalMinor: "Total",
};

// This small validator intentionally supports only the M0 receipt format.
// Unsupported proposals are removed from the draft, never presented as facts.
export function validateExpense(proposed: ExpenseDraft, source: Source) {
  const draft = structuredClone(proposed);
  const issues: ReviewIssue[] = [];
  for (const field of Object.keys(labels) as ExpenseField[]) {
    const entry = draft[field];
    if (entry.value === null) {
      entry.evidence = null;
      issues.push({ code: "missing_value", field });
      continue;
    }
    const displayed = field === "totalMinor" ? (Number(entry.value) / 100).toFixed(2) : entry.value;
    const expected = `${entry.evidence} ${labels[field]}: ${displayed}`;
    if (!entry.evidence || !source.content.split("\n").includes(expected)) {
      entry.value = null;
      entry.evidence = null;
      issues.push({ code: "unsupported_value", field });
    }
  }
  return { draft, issues, status: issues.length ? "needs_review" as const : "completed" as const };
}
