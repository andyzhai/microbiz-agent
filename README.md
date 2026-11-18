# MicroBiz Agent

A small TypeScript/LangGraph CLI with two specialists. Expense review turns a synthetic receipt into a draft with line-level evidence and arithmetic checks. Operations triage turns a synthetic service alert into a report with cited health samples, deployment events and suggested next checks. Both run in memory through the same model gateway, policy and read-only tool executor.

## Run locally

Use Node.js 24.x and npm. Install the pinned dependencies, then build before running the CLI tests.

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run demo -- receipt-normal
npm run demo -- receipt-incomplete
npm run demo -- receipt-duplicate
npm run demo -- alert-normal
npm run demo -- alert-insufficient
```

The default adapter is a deterministic offline baseline. The normal example returns CAD 12.50 as 1250 cents. On the incomplete example, date and total stay null. On the duplicate example, the model proposes `findExpenseMatches`, the workflow checks the selected receipt against synthetic prior expenses, and the draft cites prior entry `prior-017` for review.

Exit codes are `0` for completed, `2` for needs review and `1` for blocked, failed or invalid arguments. Use `npm run demo -- --help` to list the reviewed fixture IDs.

## Save a reviewed expense or operations report

After building the CLI, run either offline example from the project directory.

```sh
npm run demo -- --export receipt-normal
npm run demo -- --export alert-normal
```

The CLI shows the validation findings, destination, SHA-256 digest and exact file contents. Type the approval phrase displayed in that session to create the file. Any other response or end of input cancels the export and exits with code 2. An incomplete receipt, possible duplicate or unresolved incident report shows its findings and cannot be exported.

An approved receipt creates `.microbiz/artifacts/receipt-normal.csv` with integer cents and source-line citations. An approved alert creates `.microbiz/artifacts/alert-normal.txt` with observations, hypotheses, next checks and cited evidence. Each file can be created once at its destination. If a write fails after creation, the CLI reports `possible_partial_write` and the path. Inspect the file before removing it and approving a fresh export.

Git ignores the artifact directory. To clean up the expense demo, run `Remove-Item -LiteralPath .microbiz/artifacts/receipt-normal.csv` in PowerShell. Remove the operations demo the same way using `alert-normal.txt`.

## Daily expense and service review

Run the combined briefing after building the CLI.

```sh
npm run demo -- --objective daily-review
npm run demo -- --objective daily-review --simulate-expense-failure
```

`daily-review` is the one supported objective. It reviews `receipt-normal` first and then triages `alert-normal`. The offline briefing shows the CAD 12.50 receipt with its source line and checkout's error rate rising from 0.2% to 6.8% with both sample IDs. Each section includes the specialist's status, classification, issues and supporting results. The second command simulates an offline expense outage. It exits 1 and prints the completed service report alongside the failed expense review.

The coordinator assembles the briefing locally. Both children share a four-attempt limit, with at most two attempts for expense review and three for triage. The offline success case uses three. With `--live`, catalog discovery also consumes one shared attempt. A rate limit or exhausted parent budget skips remaining work and records the reason. Workflow state stays in memory. If interrupted, rerun the command to restart from the original fixtures.

## Operations triage

On `alert-normal`, checkout's error rate rises from 0.2% at 10:02 UTC to 6.8% at 10:15 UTC. A deployment at 10:11 UTC is a possible explanation. The report cites both samples and the event, then suggests comparing deployment changes and inspecting sampled requests.

`getServiceIncidentEvidence` reads the bundled records for the exact service and UTC window in the alert. The window includes the start and excludes the end. The demo flags a possible association when a deployment falls after the earlier sample and within ten minutes of the later, higher sample. On `alert-insufficient`, a single sample leaves the trend unknown. The CLI returns `needs_review` and suggests inspecting health history.

Run `npm run evaluate:operations` for the offline eight-alert evaluation. It scores coverage of annotated findings, evidence support for factual claims, unsupported causal assertions, and the relevance of next checks and uncertainty to each case.

## OpenRouter

For a new checkout, copy `.env.example` to `.env` and enter your `OPENROUTER_API_KEY` there. If you already have a key in `.env`, edit the two model settings in that file. Node 24 loads it for the demo, probe and evaluation commands. Environment variables take precedence. Git ignores `.env`.

```sh
npm run demo -- --live receipt-normal
npm run demo -- --live receipt-duplicate
```

Both roles process data externally. The gateway tries the roles in this order.

| Configurable environment variable | Default OpenRouter model |
| --- | --- |
| `LOCAL_MODEL` | `nvidia/nemotron-3.5-super-vl:free` |
| `CLOUD_MODEL` | `dots-studio/dots-3-note-preview:free` |

Use two distinct `provider/model:free` IDs. A normal receipt can be extracted directly. A receipt flagged as a possible resubmission gets a native lookup turn before the structured final draft. For models that advertise optional reasoning, the client requests reasoning off to leave room for the draft.

The gateway checks the current catalog for zero pricing, structured responses, tool calling and sufficient capacity. It can select the second model when the first is ineligible or temporarily unavailable. Each POST names one approved model, requires supported parameters, disables provider fallback and sets zero price ceilings. If neither qualifies, the result reports the failure. [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)

Set `OPENROUTER_MAX_TOKENS` in `.env` to a positive integer. It defaults to **10,000** and sets the `max_tokens` sent to OpenRouter. A model must support that output allowance and have room in its context window for the estimated input plus the full allowance.

The live demo allows up to four HTTP attempts including one catalog GET, with a 30-second timeout per attempt. Malformed output can receive one regeneration within that budget. A 429 ends the run. Input and decoded output are each capped at 8 KiB. For the bundled English receipts and schemas the router estimates one input token per three UTF-8 bytes, rounded up, plus 64 tokens for chat framing. Decisions include model, location, reason, attempt ordinal and reported token usage.

Only the bundled data and static application instructions can enter model context. A tool proposal can request prior expenses for the active receipt or incident evidence for the active alert. The follow-up contains the validated call and result. The executor permits at most two reads per run. Each current graph needs at most one. The CLI prints the review and discards state on exit.

### Local LLM debug logs

OpenRouter generation logging defaults to enabled. Set `LLM_DEBUG_LOG=true` in `.env` to enable it explicitly, or `LLM_DEBUG_LOG=false` to disable it for the next run. Offline demos and catalog lookups create no logs.

From the working directory, open `.microbiz/logs/`. Each workflow run has its own timestamped folder. Within it, `001-request.json` contains the body sent to OpenRouter and `001-response.json` contains the original provider JSON, including any native tool calls and token usage. Match files by number to follow tool results, repairs and alternate-model attempts. A request can stand alone if the call fails before a complete, valid JSON response arrives within the transport size limit.

HTTP headers are excluded. The logger masks configured credentials, credential fields and recognizable secrets in text, including JSON inside tool arguments. A masked credential shows its first six characters followed by `***`. Values of six characters or fewer are fully masked. Prompts and model output are otherwise readable, so keep these local files private. Git ignores `.microbiz/`.

Run these PowerShell commands from the project directory to inspect the latest run.

```powershell
$run = Get-ChildItem -Directory .microbiz/logs | Sort-Object Name -Descending | Select-Object -First 1
Get-ChildItem -LiteralPath $run.FullName
Get-Content -Raw -LiteralPath (Join-Path $run.FullName '001-response.json')
```

Delete one run by removing its folder. To delete all recorded runs from the project directory, use `Remove-Item -LiteralPath .microbiz/logs -Recurse -Force` in PowerShell or `rm -r .microbiz/logs` in a POSIX shell.

## Verification

`npm run evaluate` scores eight held-out receipts offline. It reports exact critical fields, semantic category accuracy, valid item citations, abstentions, unsupported guesses and arithmetic separately. A readable citation shows which item the model classified. The independent annotation determines whether the category is correct.

Choose **one** live probe for the question you need answered. Each command pins the selected role and disables repair and fallback. Each also uses one public catalog GET.

| Live check | Command | Maximum generation POSTs |
| --- | --- | --- |
| NVIDIA structured extraction | `npm run probe -- LOCAL_MODEL receipt-normal` | 1 |
| Dots structured extraction | `npm run probe -- CLOUD_MODEL receipt-normal` | 1 |
| NVIDIA native tool round trip | `npm run probe -- LOCAL_MODEL receipt-duplicate` | 2 |
| Dots native tool round trip | `npm run probe -- CLOUD_MODEL receipt-duplicate` | 2 |

`npm run probe` defaults to the first row. Exit 0 means the ordinary receipt produced a validated 1250-cent draft, or the duplicate receipt produced a native lookup followed by a 2260-cent draft citing `prior-017`. The expected duplicate finding is a successful probe.

For a reproducible **offline fallback check**, run `node --import tsx --test --test-name-pattern="OpenRouter HTTP contract exercises alternate selection" test/openrouter.test.ts`. The test returns HTTP 503 from the preferred model and verifies the authorized alternate and tool follow-up. A separate regression test verifies that HTTP 429 stops generation.

The optional full live evaluation, `npm run evaluate -- --live`, uses the primary role and at most eight generation POSTs total, one per held-out case. It stops on a rate limit. Use it only when you intend to spend that separate evaluation budget.

The supported inputs use a small, line-labeled receipt format. Categories are proposals for review. Arithmetic uses transcribed amounts in integer cents. The tool only compares exact merchant, date, currency and total within the demo prior-expense dataset.
