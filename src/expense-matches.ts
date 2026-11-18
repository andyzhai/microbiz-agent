import { z } from "zod";
import { categories } from "./expense.js";
import type { Source } from "./policy.js";

const priorExpenses = Object.freeze([
  Object.freeze({ id: "prior-017", merchant: "Demo Rail", date: "2026-02-04", totalMinor: 2260, currency: "CAD", category: "travel" } as const),
]);
const match = z.strictObject({ id: z.string().max(40), merchant: z.string().max(100), date: z.iso.date(),
  totalMinor: z.number().int().nonnegative(), currency: z.literal("CAD"), category: z.enum(categories) });

export const findExpenseMatches = Object.freeze({
  name: "findExpenseMatches", task: "expense-review", effect: "read", approvalRequired: false,
  classification: "synthetic",
  description: "Check this receipt against prior expenses when the receipt suggests an earlier entry. Use the supplied receipt ID.",
  args: z.strictObject({ dataset: z.literal("demo-prior-expenses"), receiptId: z.string().max(64) }),
  result: z.array(match).max(8),
  inScope(args: { receiptId: string }, source: Source) { return args.receiptId === source.id; },
  read(source: Source) {
    const lines = source.content.split("\n");
    return priorExpenses.filter(row => lines.includes("L1 Merchant: " + row.merchant) &&
      lines.includes("L2 Date: " + row.date) && lines.includes("L3 Currency: " + row.currency) &&
      lines.includes("L4 Total: " + (row.totalMinor / 100).toFixed(2)));
  },
} as const);
export type ExpenseMatch = z.infer<typeof match>;
