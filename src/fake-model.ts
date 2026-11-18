import type { ExpenseDraft } from "./expense.js";
import type { ModelAdapter, ModelRequest } from "./gateway.js";
import { OFFLINE_DESTINATION } from "./policy.js";
import { lookup } from "./profiles.js";

// Deterministic baseline for the fixture format. Never used as a live fallback.
export const fakeModel: ModelAdapter = Object.freeze({
  destination: OFFLINE_DESTINATION,
  async generate(request: ModelRequest) {
    const source = request.sources[0]!;
    if (request.instruction === lookup) return {
      name: "findExpenseMatches", arguments: { dataset: "demo-prior-expenses", receiptId: source.id },
    };
    function read(label: string) {
      const line = source.content.split("\n").find(l => l.slice(3).startsWith(label + ": "));
      const value = line?.slice(label.length + 5);
      return line && value && !value.startsWith("[") ?
        { value, evidence: line.slice(0, 2) as ExpenseDraft["merchant"]["evidence"] } : { value: null, evidence: null };
    }
    function money(label: string) {
      const { value, evidence } = read(label);
      return { value: value ? Math.round(Number(value) * 100) : null, evidence };
    }
    const item = read("Item");
    const category = !item.value ? null : /paper|pen|stationery/i.test(item.value) ? "office_supplies" :
      /train|fare/i.test(item.value) ? "travel" : /meal|lunch/i.test(item.value) ? "meals" : "other";
    return { merchant: read("Merchant"), date: read("Date"), currency: read("Currency"), totalMinor: money("Total"),
      subtotalMinor: money("Subtotal"), taxMinor: money("Tax"), category: { value: category, evidence: item.evidence } };
  },
});
