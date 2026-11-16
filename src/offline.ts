// M0 must remain offline even if the operator has tracing enabled globally.
// Import before LangGraph so dependency initialization sees these settings.
process.env.LANGSMITH_TRACING = "false";
process.env.LANGCHAIN_TRACING = "false";
process.env.LANGCHAIN_TRACING_V2 = "false";
