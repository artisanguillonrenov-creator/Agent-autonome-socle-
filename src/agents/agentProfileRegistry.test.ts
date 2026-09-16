import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProfileRegistry } from "./agentProfileRegistry.js";

function withProfilesFile(profiles: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-profiles-"));
  const path = join(dir, "agent-profiles.json");
  writeFileSync(path, JSON.stringify(profiles), "utf-8");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("un profil avec llmRole=reasoning est accepté, pas silencieusement rejeté", () => {
  withProfilesFile(
    [
      {
        id: "self_improver", name: "Auto-amélioration", role: "self_improver",
        systemPrompt: "Analyse et propose une règle.", enabled: false,
        llmRole: "reasoning", allowedSkills: ["propose_prompt_rule"], order: 30,
      },
    ],
    (path) => {
      const registry = new AgentProfileRegistry(path);
      assert.deepEqual(registry.diagnostics, [], "aucune entrée valide ne doit finir en diagnostic d'erreur");
      const profile = registry.get("self_improver");
      assert.ok(profile, "le profil reasoning doit être chargé");
      assert.equal(profile?.llmRole, "reasoning");
    },
  );
});

test("un profil avec llmRole=fast est accepté", () => {
  withProfilesFile(
    [{ id: "fast_agent", name: "Rapide", role: "fast_agent", systemPrompt: "Va vite.", enabled: true, llmRole: "fast", order: 5 }],
    (path) => {
      const registry = new AgentProfileRegistry(path);
      assert.deepEqual(registry.diagnostics, []);
      assert.equal(registry.get("fast_agent")?.llmRole, "fast");
    },
  );
});

test("un llmRole réellement invalide reste rejeté avec diagnostic", () => {
  withProfilesFile(
    [{ id: "bogus", name: "Bogus", role: "bogus", systemPrompt: "x", enabled: true, llmRole: "not_a_real_role", order: 1 }],
    (path) => {
      const registry = new AgentProfileRegistry(path);
      assert.equal(registry.get("bogus"), null);
      assert.equal(registry.diagnostics.length, 1);
    },
  );
});
