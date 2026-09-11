// The product default is Infermatic, but the unit suite must stay deterministic,
// offline and independent from external credentials/network access.
process.env.LLM_PROVIDER = "mock";
process.env.LLM_MODEL = "undi95/toppy-m-7b";
