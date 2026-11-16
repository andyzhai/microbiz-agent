import type { Source } from "./policy.js";

// Authored synthetic examples, version 1. No customer data or arbitrary file input.
// Line IDs are stable evidence references within each fixture.
const fixtures: Readonly<Record<string, Source>> = Object.freeze({
  "receipt-normal": Object.freeze({
    id: "receipt-normal",
    classification: "synthetic",
    content: [
      "L1 Merchant: Demo Paper Shop",
      "L2 Date: 2026-01-15",
      "L3 Currency: CAD",
      "L4 Total: 12.50",
    ].join("\n"),
  }),
  "receipt-incomplete": Object.freeze({
    id: "receipt-incomplete",
    classification: "synthetic",
    content: [
      "L1 Merchant: Demo Paper Shop",
      "L2 Date: [unreadable]",
      "L3 Currency: CAD",
      "L4 Total: [missing]",
    ].join("\n"),
  }),
});

export const fixtureIds = Object.freeze(Object.keys(fixtures));

export function loadFixture(id: string): Source | undefined {
  return Object.hasOwn(fixtures, id) ? fixtures[id] : undefined;
}
