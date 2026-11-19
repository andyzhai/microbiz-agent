# MicroBiz Agent

**MicroBiz Agent** is an experimental, privacy-aware multi-agent platform for small-business automation, built with TypeScript and LangGraph.

Its core principle is **privacy-aware AI execution**: sensitive business data is processed by local AI models, while general, non-sensitive tasks can use more capable cloud models. A deterministic policy and routing layer enforces these boundaries rather than relying on LLM decisions.

An executive agent coordinates specialized business agents for bookkeeping, technical operations, marketing and other business workflows, with controlled tool access and human approval for consequential actions.

**Current status:** The prototype includes specialist workflows, basic executive coordination, OpenRouter integration, MCP tools, approved exports and durable review recovery. True local-model inference and verified sensitive-data processing are planned for M7 and are **not yet implemented**.