import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { ServiceRegistry } from "./serviceRegistry.js";
import { ServiceAdapter } from "./serviceAdapter.js";
import { ServiceOrchestrator } from "./serviceOrchestrator.js";

function setupTestDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

function withStubbedFetch<T>(run: () => Promise<T>): Promise<T> & { calls: () => string[] } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    calls.push(typeof input === "string" ? input : input?.url ?? String(input));
    throw new Error(`UNEXPECTED_NETWORK_CALL: ${calls[calls.length - 1]}`);
  }) as typeof fetch;
  const promise = run().finally(() => {
    globalThis.fetch = original;
  }) as Promise<T> & { calls: () => string[] };
  promise.calls = () => calls;
  return promise;
}

test("software_factory is registered as a local in-process service and Mock Software Factory Service no longer exists", () => {
  setupTestDb();
  const registry = new ServiceRegistry();

  const sf = registry.getServiceById("software_factory");
  assert.ok(sf);
  assert.equal(sf?.transport, "local");
  assert.equal(sf?.endpoint, "software_factory");

  assert.equal(registry.getServiceById("mock_software_factory"), null);
  assert.ok(!registry.listServices().some((s) => s.id === "mock_software_factory"));
});

test("ServiceAdapter checkHealth reports software_factory as reachable locally with zero network calls", async () => {
  setupTestDb();
  const registry = new ServiceRegistry();
  const adapter = new ServiceAdapter();
  const service = registry.getServiceById("software_factory")!;

  const run = withStubbedFetch(() => adapter.checkHealth(service));
  const health = await run;

  assert.equal(health.reachable, true);
  assert.equal(health.status, 200);
  assert.equal(health.errorCode, undefined);
  assert.deepEqual(run.calls(), []);
});

test("software_development is dispatched to the local Software Factory service, never to localhost:10000 or :4000", async () => {
  setupTestDb();
  const orchestrator = new ServiceOrchestrator();

  const run = withStubbedFetch(() =>
    orchestrator.dispatchCapability({
      action: "DISPATCH_CAPABILITY",
      capability: "software_development",
      objective: "Objectif sans chemin de fichier pour rester 100% local et sans appel réseau",
    }),
  );
  const result = await run;

  assert.equal(result.selectedService, "software_factory");
  assert.equal(result.status, "FAILED");
  assert.ok(result.error?.includes("FILE_PATH_MISSING"), `unexpected error: ${result.error}`);
  assert.deepEqual(run.calls(), []);
});

test("a legacy DB override pointing at a retired HTTP address is migrated away and cannot shadow the local transport", () => {
  const previousPath = config.db.path;
  const directory = mkdtempSync(join(tmpdir(), "jarvis-sf-migration-"));
  const databasePath = join(directory, "legacy.sqlite");
  closeDb();

  try {
    const legacyDb = new Database(databasePath);
    legacyDb.exec(`
      CREATE TABLE service_connections (
        service_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_override TEXT,
        user_created INTEGER NOT NULL DEFAULT 0,
        enabled_override INTEGER,
        transport_override TEXT,
        endpoint_override TEXT,
        health_path TEXT,
        task_path TEXT,
        auth_type_override TEXT,
        auth_env_var TEXT,
        priority_override INTEGER,
        request_timeout_ms INTEGER,
        health_timeout_ms INTEGER,
        capabilities_json TEXT,
        parallel_safe_capabilities_json TEXT,
        risk_by_capability_json TEXT,
        last_test_at INTEGER,
        last_success_at INTEGER,
        last_latency_ms INTEGER,
        last_error TEXT,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO service_connections (service_id, name, user_created, transport_override, endpoint_override, auth_type_override, auth_env_var, updated_at)
      VALUES ('software_factory', 'Software Factory Service V1', 0, 'task_http', 'http://localhost:10000', 'bearer_env', 'SOFTWARE_FACTORY_TOKEN', 1700000000000);
      INSERT INTO service_connections (service_id, name, user_created, transport_override, endpoint_override, updated_at)
      VALUES ('mock_software_factory', 'Mock Software Factory Service', 0, 'task_http', 'http://localhost:4000', 1700000000000);
    `);
    legacyDb.close();

    config.db.path = databasePath;
    getDb();

    const registry = new ServiceRegistry();

    // The stale override can no longer reintroduce the old HTTP addresses.
    const override = registry.connectionStore.getOverride("software_factory");
    assert.equal(override?.transportOverride, undefined);
    assert.equal(override?.endpointOverride, undefined);

    const sf = registry.getServiceById("software_factory");
    assert.equal(sf?.transport, "local");
    assert.equal(sf?.endpoint, "software_factory");

    // Mock Software Factory Service is fully removed, including any persisted row.
    assert.equal(registry.connectionStore.getOverride("mock_software_factory"), null);
    assert.equal(registry.getServiceById("mock_software_factory"), null);

    // Running the migration again (e.g. on a subsequent restart) is a harmless no-op.
    closeDb();
    getDb();
    const registryAfterRestart = new ServiceRegistry();
    assert.equal(registryAfterRestart.getServiceById("software_factory")?.transport, "local");
  } finally {
    closeDb();
    config.db.path = previousPath;
    rmSync(directory, { recursive: true, force: true });
    getDb();
  }
});
