// The product default is Infermatic, but the unit suite must stay deterministic,
// offline and independent from external credentials/network access.
process.env.LLM_PROVIDER = "mock";
process.env.LLM_MODEL = "undi95/toppy-m-7b";

// Vague 8A : le disjoncteur financier est un état process-wide persisté en base — actif par
// défaut en production, il n'a aucune raison d'observer/geler la suite de tests unitaires
// (des centaines d'appels LLM factices ne doivent jamais accumuler un "coût" qui bloquerait
// des tests sans rapport). Un test dédié au disjoncteur lui-même le réactive explicitement.
process.env.FINANCIAL_CIRCUIT_BREAKER_ENABLED = "false";
