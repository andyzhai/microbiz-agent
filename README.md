# MicroBiz Agent

A small TypeScript/LangGraph platform for business specialists sharing model access and deterministic policy checks. The project supports practical agent-engineering learning and incremental development toward a business product.

**Current scope: M0, an offline prototype.** A CLI selects a bundled synthetic receipt, runs a scripted fake model through the gateway, validates its fields and evidence, and prints a draft or an explicit review-required result. No credentials are needed and no model service is contacted.

## Run locally

Use Node.js 24.x and npm (verified with Node 24.20.0 and npm 11.19.0).

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run demo -- receipt-normal
npm run demo -- receipt-incomplete
```

Dependency installation requires access to npm or a populated package cache. After installation, builds, tests and demonstrations run offline. Tests include the built CLI, so build before running them.

The normal example prints `completed` with merchant, date, CAD currency and total in integer minor units (`1250` means CAD 12.50). Each non-null field cites a receipt line ID in the selected fixture. The incomplete example prints `needs_review`, with missing date and total left `null` and listed as review issues. Unsupported model values are removed and flagged; malformed output fails with no draft.

Exit codes: `0` completed, `2` needs review (expected for the incomplete example), `1` blocked, failed or invalid arguments. `npm run demo -- --help` lists fixture IDs. Arbitrary paths, pasted documents, classification flags and resume commands are unsupported.

## Platform direction

The platform uses one package, CLI and process. Current flow:

```text
Bundled fixture ID → trusted loader → expense LangGraph
                                       ↓
                               gateway → policy → fake adapter
                                       ↓
                              domain validation → console draft
```

The gateway owns model dispatch, schema checks, bounded attempts, request timeout and size limits. Policy checks source provenance and the actual configured destination; neither module depends on receipt fields. The expense workflow owns its output schema and evidence rules. Decision metadata includes model/location, reason, attempt count, duration and unknown usage; it excludes raw prompts and provider errors. Remote tracing is disabled even when enabled in the shell environment.

Later milestones introduce real expense review and controlled read tools, then an operations-triage specialist and a small sequential coordinator. Both planned initial model roles (`LOCAL_MODEL` and `CLOUD_MODEL`) use external OpenRouter models; the local role name does not imply local processing or privacy. Approved local export, durable review, MCP and verified local inference are separate later increments.

## Limits and development

- Only two authored synthetic fixtures are available, in `src/fixtures.ts`. A synthetic label or a matching ID on caller-provided content cannot authorize it.
- The only permitted destination is the in-memory fake adapter. No network adapter, business tool, coordinator, export or database is implemented.
- Fake responses test the workflow, not real model quality. Validation supports only the bundled four-field receipt format; no categories, tax calculations, duplicate matching or accounting decisions are made.
- A run normally uses one model attempt. The per-run gateway ceiling is four attempts, with a one-second request timeout and 8 KiB input/output caps; M0 has no automatic retries or fallback.
- State exists only in memory. Process exit discards it; start again from a fixture. There is no persistence or resume support.
- These application checks are not an OS sandbox. Real business data and production use are outside this prototype's scope.

Application source, synthetic fixtures and automated tests are self-contained here. Contributions should retain the gateway/policy boundary and add relevant offline tests. `npm test` uses Node's test runner; transport spies verify denied calls and child-process tests prohibit network access while exercising the built CLI.
