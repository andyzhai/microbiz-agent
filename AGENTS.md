# Project instructions

## Conserve the OpenRouter free quota

- Use offline tests and recorded results for development and verification. Send a live model request only when the operator explicitly asks for live verification.
- Before the first live call, state the question being tested and the maximum number of generation attempts for the entire task. Use any quota information already available. Treat an unknown balance as scarce. Never send a generation just to check the balance.
- Default to **one generation attempt total**, pinned to one free model and one fixture. If the operator explicitly requests a check that needs multiple calls, use its smallest possible budget. For example, a native tool round trip needs two generations: the tool proposal and the final response. A request to find a working model starts with one candidate.
- Enforce the stated budget before dispatch. Count every generation POST, including failures, timeouts, repairs, retries and alternate-model attempts. Run calls sequentially. Disable automatic repair and fallback during probes unless that behavior is the specific test. Check what a script will send before running it.
- Stop as soon as the question is answered, the budget is spent, or OpenRouter returns HTTP 429 or reports an exhausted quota. Report the attempts and outcome. Wait for explicit operator approval before spending additional attempts. A quota reset alone does not authorize a retest.
