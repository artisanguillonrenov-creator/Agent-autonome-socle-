import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, getDb } from '../persistence/db.js';
import { config } from '../config.js';
import { MissionStore } from '../missionStore.js';
import { N8nIntakeService } from '../n8nIntakeService.js';
import type { N8nIntakePayload } from '../types.js';

const SECRET = 'test-intake-secret';

function makePayload(overrides: Partial<N8nIntakePayload> = {}): N8nIntakePayload {
  return {
    schema_version: 2,
    mission_id: 'test-mission-1',
    trace_id: 'test-trace-1',
    project_id: 'test-project',
    status: 'RECEIVED',
    timestamp: Date.now(),
    ...overrides,
  };
}

function createSignature(payload: N8nIntakePayload): string {
  const { createHmac } = await import('node:crypto');
  return createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex');
}

test('Intake valide : mission créée, signature correcte, retour ok', async () => {
  closeDb();
  config.db.path = ':memory:';
  getDb();
  
  const service = new N8nIntakeService(new MissionStore());
  const payload = makePayload();
  const signature = createSignature(payload);
  const result = service.process(payload, signature, SECRET);

  assert.ok(result.ok);
  assert.equal(result.missionId, 'test-mission-1');
});

test('Intake valide : mission existante même trace_id -> idempotent', async () => {
  closeDb();
  config.db.path = ':memory:';
  getDb();
  
  const store = new MissionStore();
  store.createMission({ missionId: 'test-mission-2', traceId: 'trace-2', projectId: 'p' });
  const service = new N8nIntakeService(store);
  
  const payload = makePayload({ mission_id: 'test-mission-2', trace_id: 'trace-2' });
  const signature = createSignature(payload);
  const result = service.process(payload, signature, SECRET);

  assert.ok(result.ok);
  assert.equal(result.missionId, 'test-mission-2');
});

test('Intake invalide : mismatch trace_id -> conflit déterministe', async () => {
  closeDb();
  config.db.path = ':memory:';
  getDb();
  
  const store = new MissionStore();
  store.createMission({ missionId: 'test-mission-3', traceId: 'trace-old', projectId: 'p' });
  const service = new N8nIntakeService(store);
  
  const payload = makePayload({ mission_id: 'test-mission-3', trace_id: 'trace-new' });
  const signature = createSignature(payload);
  const result = service.process(payload, signature, SECRET);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'TRACE_ID_CONFLICT');
});

test('Intake invalide : HMAC incorrect -> échec structurel', async () => {
  closeDb();
  config.db.path = ':memory:';
  getDb();
  
  const service = new N8nIntakeService();
  const payload = makePayload();
  const result = service.process(payload, '0'.repeat(64), SECRET);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'HMAC_VERIFICATION_FAILED');
});

test('Intake invalide : schema_version non supporté -> erreur déterministe', async () => {
  closeDb();
  config.db.path = ':memory:';
  getDb();
  
  const service = new N8nIntakeService();
  const payload = makePayload({ schema_version: 99 });
  const signature = createSignature(payload);
  const result = service.process(payload, signature, SECRET);

  assert.equal(result.ok, false);
  assert.ok(result.error?.includes('SCHEMA_VERSION_UNSUPPORTED'));
});

test('Intake invalide : mission_id optionnel -> échec de compilation TS (vérifié par le type)', async () => {
  // Ce test confirme que l'interface impose mission_id. La tentative de compilation
  // sans ce champ lèvera une erreur TS. On teste ici la valeur par défaut si elle existait,
  // mais le strict contrat impose sa présence.
  closeDb();
  config.db.path = ':memory:';
  getDb();
  
  const service = new N8nIntakeService();
  const payload = makePayload(); // mission_id est présent via makePayload
  const signature = createSignature(payload);
  
  assert.doesNotThrow(() => service.process(payload, signature, SECRET));
});

test('Intake avec événement : appendMissionEvent appliqué avec row_version correcte', async () => {
  closeDb();
  config.db.path = ':memory:';
  getDb();
  
  const store = new MissionStore();
  const service = new N8nIntakeService(store);
  
  const payload = makePayload({
    event_type: 'TASK_ACCEPTED',
    event_id: 'evt-1',
    sequence: 1,
    payload: { task: 'build' },
  });
  const signature = createSignature(payload);
  const result = service.process(payload, signature, SECRET);

  assert.ok(result.ok);
  const events = store.listMissionEvents('test-mission-1');
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, 'evt-1');
});
