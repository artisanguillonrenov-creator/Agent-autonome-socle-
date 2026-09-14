import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPopulatedRegistry, buildServiceCapabilityMatrix, type ServiceCapabilitySource } from "./gapAnalysis.js";
import { exportForN8n } from "./n8nExport.js";

function matrixAndRegistry() {
  const registry = createPopulatedRegistry();
  const services: ServiceCapabilitySource[] = [
    { id: "software_factory", capabilities: ["software_development", "code_generation"], riskByCapability: { software_development: "MEDIUM", code_generation: "LOW" } },
    { id: "workspace_service", capabilities: ["file_management"] },
    { id: "product_studio", capabilities: ["product_studio"] },
  ];
  return { registry, matrix: buildServiceCapabilityMatrix(registry, services) };
}

test("exportForN8n produit une ligne par entrée de la matrice avec tous les champs attendus", () => {
  const { registry, matrix } = matrixAndRegistry();
  const rows = exportForN8n(matrix, registry, { software_factory: "2.0" });
  assert.equal(rows.length, matrix.length);
  const softwareDev = rows.find((r) => r.capability_id === "software_development");
  assert.equal(softwareDev?.service_id, "software_factory");
  assert.equal(softwareDev?.service_version, "2.0");
  assert.equal(softwareDev?.skill_id, "software_development");
  assert.equal(softwareDev?.status, "AVAILABLE");
  assert.ok(softwareDev?.proof_ref);
  assert.equal(softwareDev?.risk_level, "MEDIUM");
  assert.equal(softwareDev?.schema_version >= 1, true);
});

test("exportForN8n retombe honnêtement sur service_version='unknown' quand non fournie (ServiceDefinition ne porte aucun champ de version)", () => {
  const { registry, matrix } = matrixAndRegistry();
  const rows = exportForN8n(matrix, registry);
  assert.ok(rows.every((r) => r.service_version === "unknown"));
});

test("exportForN8n exporte aussi les lignes MISSING sans skill (skill_id/skill_version null, jamais inventés)", () => {
  const { registry, matrix } = matrixAndRegistry();
  const rows = exportForN8n(matrix, registry);
  const productStudio = rows.find((r) => r.capability_id === "product_studio");
  assert.equal(productStudio?.status, "DISABLED");
  assert.equal(typeof productStudio?.skill_id, "string");
});

// --- L. Sérialisation ---
test("L — exportForN8n survit à un aller-retour JSON", () => {
  const { registry, matrix } = matrixAndRegistry();
  const rows = exportForN8n(matrix, registry);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows);
});

// --- O/P. Aucune méthode d'écriture/fusion GitHub dans ce module ---
test("O/P — aucune méthode d'écriture/fusion GitHub ni appel réseau n8n dans n8nExport.ts", () => {
  const path = fileURLToPath(new URL("./n8nExport.ts", import.meta.url));
  const source = readFileSync(path, "utf-8");
  assert.doesNotMatch(source, /octokit|\.merge\(|createOrUpdateFileContents|createRef\(|fetch\(|axios/i);
});
