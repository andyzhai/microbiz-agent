import type { ExpenseDraft } from "./expense.js";
import type { ModelAdapter, ModelRequest } from "./gateway.js";
import { OFFLINE_DESTINATION } from "./policy.js";

// Scripted responses exercise orchestration and validation, not model quality.
export const fakeModel: ModelAdapter = Object.freeze({
  destination: OFFLINE_DESTINATION,
  async generate(request: ModelRequest): Promise<ExpenseDraft> {
    const complete = request.sources[0]?.id === "receipt-normal";
    return {
      merchant: { value: "Demo Paper Shop", evidence: "L1" },
      date: { value: complete ? "2026-01-15" : null, evidence: complete ? "L2" : null },
      currency: { value: "CAD", evidence: "L3" },
      totalMinor: { value: complete ? 1250 : null, evidence: complete ? "L4" : null },
    };
  },
});
