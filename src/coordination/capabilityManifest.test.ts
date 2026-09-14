import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  defineCapability,
  CAPABILITY_STATUSES,
  CapabilityDescriptorInvalidError,
  CapabilityNotProvenError,
  type CapabilityDescriptorInput,
} from "./capabilityManifest.js";
import { JARVIS00_CONTRACTS_SCHEMA_VERSION } from "./contracts.js";

function validInput(overrides: Partial<CapabilityDescriptorInput> = {}): CapabilityDescriptorInput {
  return {
    serviceId: "software_factory",
    serviceVersion: "2.0",
    capabilityId: "read_ci_status",
    capabilityName: "Lire le statut CI réel d'une PR",
    status: "NOT_TESTED",
    inputSchemaRef: "schemas/read_ci_status.input.json",
    outputSchemaRef: "schemas/read_ci_status.output.json",
    riskLevel: "LOW",
    permissionLevel: "read",
    sideEffects: false,
    idempotent: true,
    asyncSupported: false,
    timeoutMs: 5000,
    dependencies: [],
    ...overrides,
  };
}

// --- 9. Capability manifest valide ---

test("9 — defineCapability construit un descripteur valide (statut non AVAILABLE, sans preuve requise)", () => {
  const descriptor = defineCapability(validInput());
  assert.equal(descriptor.capabilityId, "read_ci_status");
  assert.equal(descriptor.status, "NOT_TESTED");
  assert.equal(descriptor.schemaVersion, JARVIS00_CONTRACTS_SCHEMA_VERSION);
});

test("9 — defineCapability accepte AVAILABLE lorsqu'une preuve réelle (proofRef) est fournie", () => {
  const descriptor = defineCapability(validInput({ status: "AVAILABLE", proofRef: "test:softwareFactoryService.test.ts#TEST-Q", lastVerifiedAt: Date.now() }));
  assert.equal(descriptor.status, "AVAILABLE");
  assert.ok(descriptor.proofRef);
});

// --- 10. Capacité non prouvée jamais marquée AVAILABLE automatiquement ---

test("10 — defineCapability refuse AVAILABLE sans proofRef", () => {
  assert.throws(() => defineCapability(validInput({ status: "AVAILABLE" })), CapabilityNotProvenError);
});

test("10 — defineCapability refuse AVAILABLE avec un proofRef vide ou uniquement des espaces", () => {
  assert.throws(() => defineCapability(validInput({ status: "AVAILABLE", proofRef: "" })), CapabilityNotProvenError);
  assert.throws(() => defineCapability(validInput({ status: "AVAILABLE", proofRef: "   " })), CapabilityNotProvenError);
});

test("10 — les statuts non-AVAILABLE ne requièrent jamais de proofRef", () => {
  for (const status of CAPABILITY_STATUSES) {
    if (status === "AVAILABLE") continue;
    assert.doesNotThrow(() => defineCapability(validInput({ status })), `status=${status} ne doit pas exiger de preuve`);
  }
});

// --- 2. Validation des champs obligatoires ---

test("2 — defineCapability rejette les champs obligatoires manquants ou invalides", () => {
  const base = validInput();
  assert.throws(() => defineCapability({ ...base, serviceId: "" }), CapabilityDescriptorInvalidError);
  assert.throws(() => defineCapability({ ...base, serviceVersion: "" }), CapabilityDescriptorInvalidError);
  assert.throws(() => defineCapability({ ...base, capabilityId: "" }), CapabilityDescriptorInvalidError);
  assert.throws(() => defineCapability({ ...base, capabilityName: "" }), CapabilityDescriptorInvalidError);
  assert.throws(() => defineCapability({ ...base, status: "UNKNOWN_STATUS" as never }), CapabilityDescriptorInvalidError);
  assert.throws(() => defineCapability({ ...base, timeoutMs: 0 }), CapabilityDescriptorInvalidError);
  assert.throws(() => defineCapability({ ...base, timeoutMs: -1 }), CapabilityDescriptorInvalidError);
  assert.throws(() => defineCapability({ ...base, dependencies: undefined as unknown as string[] }), CapabilityDescriptorInvalidError);
});

// --- 1. Sérialisation / désérialisation ---

test("1 — CapabilityDescriptor survit à un aller-retour JSON", () => {
  const descriptor = defineCapability(validInput({ status: "AVAILABLE", proofRef: "test:x" }));
  assert.deepEqual(JSON.parse(JSON.stringify(descriptor)), descriptor);
});

// --- Réutilisation du RiskLevel existant (src/orchestration/contract.ts) ---

test("defineCapability accepte les 4 RiskLevel déjà stabilisés par l'orchestration", () => {
  for (const riskLevel of ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const) {
    const descriptor = defineCapability(validInput({ riskLevel }));
    assert.equal(descriptor.riskLevel, riskLevel);
  }
});

// --- 12. Aucun chemin permettant merge automatique ---

test("12 — aucune méthode d'écriture/fusion GitHub dans capabilityManifest.ts (vérification statique)", () => {
  const path = fileURLToPath(new URL("./capabilityManifest.ts", import.meta.url));
  const source = readFileSync(path, "utf-8");
  assert.doesNotMatch(source, /octokit|\.merge\(|createOrUpdateFileContents|createRef\(/i);
});
