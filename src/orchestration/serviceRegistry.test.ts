import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBureauLlmConfig, setBureauLlmConfig } from "./serviceRegistry.js";

function withTempServicesFile(run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "bureau-llm-"));
  const path = join(dir, "services.json");
  writeFileSync(
    path,
    JSON.stringify([
      { id: "product_studio", name: "Product Studio", enabled: true, transport: "local", endpoint: "product_studio", auth: { type: "none" }, capabilities: ["product_studio"], priority: 20 },
      { id: "creative_studio", name: "Creative Studio", enabled: true, transport: "local", endpoint: "creative_studio", auth: { type: "none" }, capabilities: ["creative_studio"], priority: 20 },
    ]),
  );
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("getBureauLlmConfig : renvoie vide quand rien n'est configuré pour le bureau", () => {
  withTempServicesFile((path) => {
    assert.deepEqual(getBureauLlmConfig("product_studio", path), {});
  });
});

test("setBureauLlmConfig : persiste provider/modèle pour un seul bureau, sans toucher aux autres champs ni aux autres bureaux", () => {
  withTempServicesFile((path) => {
    const updated = setBureauLlmConfig("product_studio", { provider: "openai", model: "gpt-4o" }, path);
    assert.deepEqual(updated, { provider: "openai", model: "gpt-4o" });

    assert.deepEqual(getBureauLlmConfig("product_studio", path), { provider: "openai", model: "gpt-4o" });
    assert.deepEqual(getBureauLlmConfig("creative_studio", path), {});

    const raw = JSON.parse(readFileSync(path, "utf8"));
    const product = raw.find((s: any) => s.id === "product_studio");
    assert.equal(product.provider, "openai");
    assert.equal(product.model, "gpt-4o");
    assert.equal(product.enabled, true);
    assert.equal(product.priority, 20);
  });
});

test("setBureauLlmConfig : une chaîne vide efface l'override existant (retour au fallback global)", () => {
  withTempServicesFile((path) => {
    setBureauLlmConfig("product_studio", { provider: "anthropic", model: "claude-3-5-sonnet-latest" }, path);
    setBureauLlmConfig("product_studio", { provider: "", model: "" }, path);
    assert.deepEqual(getBureauLlmConfig("product_studio", path), {});
  });
});

test("setBureauLlmConfig : rejette un provider inconnu ou un service inconnu", () => {
  withTempServicesFile((path) => {
    assert.throws(() => setBureauLlmConfig("product_studio", { provider: "not-a-provider" }, path), /INVALID_LLM_PROVIDER/);
    assert.throws(() => setBureauLlmConfig("commercial_office", { provider: "openai" }, path), /SERVICE_NOT_FOUND/);
  });
});
