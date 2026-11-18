import { z } from "zod";
import type { Source } from "./policy.js";

export const categories = Object.freeze(["office_supplies", "travel", "meals", "other"] as const);
const evidence = z.enum(["L1","L2","L3","L4","L5","L6","L7","L8"]).nullable();
const field = <T extends z.ZodType>(value: T) => z.strictObject({ value: value.nullable(), evidence });
const amount = field(z.number().int().min(0).max(100_000_000));
export const expenseSchema = z.strictObject({
  merchant: field(z.string().min(1).max(100)), date: field(z.iso.date()), currency: field(z.literal("CAD")),
  totalMinor: amount, subtotalMinor: amount, taxMinor: amount, category: field(z.enum(categories)),
});
export type ExpenseDraft = z.infer<typeof expenseSchema>;
export type ExpenseField = keyof ExpenseDraft;
export type ReviewIssue = {
  readonly code: "missing_value" | "unsupported_value" | "arithmetic_mismatch" | "possible_duplicate" | "lookup_needed";
  readonly field?: ExpenseField;
} | { readonly code: "invalid_category_evidence"; readonly field: "category"; readonly proposedCategory: NonNullable<ExpenseDraft["category"]["value"]> };

const labels = { merchant: "Merchant", date: "Date", currency: "Currency", totalMinor: "Total",
  subtotalMinor: "Subtotal", taxMinor: "Tax", category: "Item" };

export function validateExpense(proposed: ExpenseDraft, source: Source) {
  const draft = structuredClone(proposed);
  const issues: ReviewIssue[] = [];
  const lines = source.content.split("\n");
  for (const field of Object.keys(labels) as ExpenseField[]) {
    const entry = draft[field];
    const amountDetail = field === "subtotalMinor" || field === "taxMinor";
    if (entry.value === null) {
      entry.evidence = null;
      if (!amountDetail || lines.some(line => line.includes(` ${labels[field]}: `))) {
        issues.push({ code: "missing_value", field });
      }
      continue;
    }
    const prefix = `${entry.evidence} ${labels[field]}: `;
    const displayed = field.endsWith("Minor") ? (Number(entry.value) / 100).toFixed(2) : entry.value;
    if (field === "category") {
      // A readable item is evidence for a proposal. Its business meaning is scored by the evaluator.
      const item = lines.find(line => line.startsWith(prefix))?.slice(prefix.length).trim();
      if (entry.evidence && item && !item.startsWith("[")) continue;
      issues.push({ code: "invalid_category_evidence", field, proposedCategory: draft.category.value! });
      draft.category = { value: null, evidence: null };
    } else if (!entry.evidence || !lines.includes(prefix + displayed) || String(displayed).startsWith("[")) {
      entry.value = null;
      entry.evidence = null;
      issues.push({ code: "unsupported_value", field });
    }
  }
  const { totalMinor, subtotalMinor, taxMinor } = draft;
  if (subtotalMinor.value !== null && taxMinor.value !== null && totalMinor.value !== null &&
      subtotalMinor.value + taxMinor.value !== totalMinor.value) issues.push({ code: "arithmetic_mismatch" });
  return { draft, issues, status: issues.length ? "needs_review" as const : "completed" as const };
}
