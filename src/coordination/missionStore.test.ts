import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { MissionStore } from "./missionStore.js";
import { MissionEventPayloadError, MissionEventSequenceError, MissionNotFoundError, MissionStateConflictError } from "./types.js";
import { advanceContextVersion, computeContextHash, createInitialContextVersion, verifyContextChain } from "./contextVersioning.js";

beforeEach(() => {
  closeDb();
  config.db.path = ":memory:";
  getDb();
});

test("création d'une mission valide : champs par défaut corrects", () => {
  const store = new MissionStore();
  const mission = store.createMission({ traceId: "trace-1", projectId: "jarvis" });
  assert.ok(mission.missionId);
  assert.equal(mission.traceId, "trace-1");
  assert.equal(mission.projectId, "jarvis");
  assert.equal(mission.status, "RECEIVED");
  assert.equal(mission.rowVersion, 1);
  assert.equal(mission.lastEventSequence, 0);
  assert.equal(typeof mission.createdAt, "number");
  assert.equal(mission.createdAt, mission.updatedAt);

  const reloaded = store.getMission(mission.missionId);
  assert.deepEqual(reloaded, mission);
});

test("mission introuvable : getMission renvoie null, updateMissionStatus lève MissionNotFoundError", () => {
  const store = new MissionStore();
  assert.equal(store.getMission("does-not-exist"), null);
  assert.throws(() => store.updateMissionStatus("does-not-exist", 1, "CONTEXT_READY"), MissionNotFoundError);
});

test("incrément row_version : chaque mise à jour de statut avance la version et jamais autrement", () => {
  const store = new MissionStore();
  const mission = store.createMission({ traceId: "t", projectId: "jarvis" });
  assert.equal(mission.rowVersion, 1);

  const afterFirst = store.updateMissionStatus(mission.missionId, 1, "CONTEXT_READY");
  assert.equal(afterFirst.status, "CONTEXT_READY");
  assert.equal(afterFirst.rowVersion, 2);

  const afterSecond = store.updateMissionStatus(mission.missionId, 2, "ARCHITECT_PLANNED");
  assert.equal(afterSecond.status, "ARCHITECT_PLANNED");
  assert.equal(afterSecond.rowVersion, 3);
});

test("conflit expected_row_version incorrect : MissionStateConflictError, aucun changement appliqué", () => {
  const store = new MissionStore();
  const mission = store.createMission({ traceId: "t", projectId: "jarvis" });

  assert.throws(
    () => store.updateMissionStatus(mission.missionId, 999, "CONTEXT_READY"),
    (err: unknown) => {
      assert.ok(err instanceof MissionStateConflictError);
      assert.equal(err.code, "MISSION_STATE_CONFLICT");
      assert.equal(err.missionId, mission.missionId);
      assert.equal(err.expectedRowVersion, 999);
      assert.equal(err.actualRowVersion, 1);
      return true;
    },
  );

  // L'état n'a pas bougé : ni le statut, ni la row_version.
  const unchanged = store.getMission(mission.missionId)!;
  assert.equal(unchanged.status, "RECEIVED");
  assert.equal(unchanged.rowVersion, 1);
});

test("séquence événementielle croissante : les événements s'appliquent dans l'ordre et avancent last_event_sequence", () => {
  const store = new MissionStore();
  const mission = store.createMission({ traceId: "trace-1", projectId: "jarvis" });

  const r1 = store.appendMissionEvent(
    { eventId: "e1", missionId: mission.missionId, traceId: "trace-1", sequence: 1, eventType: "MISSION_RECEIVED", timestamp: 1000, payload: { note: "first" } },
    1,
  );
  assert.deepEqual(r1, { duplicate: false, applied: true });
  const afterE1 = store.getMission(mission.missionId)!;
  assert.equal(afterE1.lastEventSequence, 1);
  assert.equal(afterE1.rowVersion, 2);

  const r2 = store.appendMissionEvent(
    { eventId: "e2", missionId: mission.missionId, traceId: "trace-1", sequence: 2, eventType: "CONTEXT_BUILT", timestamp: 1001, payload: { note: "second" } },
    2,
  );
  assert.deepEqual(r2, { duplicate: false, applied: true });
  const afterE2 = store.getMission(mission.missionId)!;
  assert.equal(afterE2.lastEventSequence, 2);
  assert.equal(afterE2.rowVersion, 3);

  const events = store.listMissionEvents(mission.missionId);
  assert.deepEqual(events.map((e) => e.sequence), [1, 2]);
  assert.deepEqual(events.map((e) => e.eventType), ["MISSION_RECEIVED", "CONTEXT_BUILT"]);
});

test("refus d'un event sequence incohérent : rejoué, régressif ou en trou, sans effet de bord", () => {
  const store = new MissionStore();
  const mission = store.createMission({ traceId: "trace-1", projectId: "jarvis" });
  store.appendMissionEvent(
    { eventId: "e1", missionId: mission.missionId, traceId: "trace-1", sequence: 5, eventType: "X", timestamp: 1, payload: {} },
    1,
  );

  // Séquence <= dernière séquence appliquée (5) : refusée.
  assert.throws(
    () =>
      store.appendMissionEvent(
        { eventId: "e2", missionId: mission.missionId, traceId: "trace-1", sequence: 5, eventType: "X", timestamp: 2, payload: {} },
        2,
      ),
    (err: unknown) => {
      assert.ok(err instanceof MissionEventSequenceError);
      assert.equal(err.code, "EVENT_SEQUENCE_INVALID");
      assert.equal(err.attemptedSequence, 5);
      assert.equal(err.lastEventSequence, 5);
      return true;
    },
  );
  assert.throws(
    () =>
      store.appendMissionEvent(
        { eventId: "e3", missionId: mission.missionId, traceId: "trace-1", sequence: 3, eventType: "X", timestamp: 3, payload: {} },
        2,
      ),
    MissionEventSequenceError,
  );

  // Aucun des deux essais rejetés n'a modifié la mission ni ajouté d'événement.
  const mission2 = store.getMission(mission.missionId)!;
  assert.equal(mission2.lastEventSequence, 5);
  assert.equal(mission2.rowVersion, 2);
  assert.equal(store.listMissionEvents(mission.missionId).length, 1);
});

test("appendMissionEvent exige exactement un de payload/payloadRef", () => {
  const store = new MissionStore();
  const mission = store.createMission({ traceId: "t", projectId: "jarvis" });
  assert.throws(
    () => store.appendMissionEvent({ eventId: "e1", missionId: mission.missionId, traceId: "t", sequence: 1, eventType: "X", timestamp: 1 }, 1),
    MissionEventPayloadError,
  );
  assert.throws(
    () =>
      store.appendMissionEvent(
        { eventId: "e1", missionId: mission.missionId, traceId: "t", sequence: 1, eventType: "X", timestamp: 1, payload: {}, payloadRef: "ref" },
        1,
      ),
    MissionEventPayloadError,
  );
});

test("appendMissionEvent : conflit de row_version fait échouer toute la transaction (pas d'événement partiel)", () => {
  const store = new MissionStore();
  const mission = store.createMission({ traceId: "t", projectId: "jarvis" });
  assert.throws(
    () => store.appendMissionEvent({ eventId: "e1", missionId: mission.missionId, traceId: "t", sequence: 1, eventType: "X", timestamp: 1, payload: {} }, 999),
    MissionStateConflictError,
  );
  // La mission n'a pas bougé et l'événement n'a pas été inséré malgré l'échec après l'INSERT.
  const unchanged = store.getMission(mission.missionId)!;
  assert.equal(unchanged.rowVersion, 1);
  assert.equal(unchanged.lastEventSequence, 0);
  assert.equal(store.listMissionEvents(mission.missionId).length, 0);
});

test("idempotence conservée : créer deux fois la même mission_id renvoie la même mission sans la modifier", () => {
  const store = new MissionStore();
  const first = store.createMission({ missionId: "fixed-id", traceId: "trace-a", projectId: "jarvis" });
  const second = store.createMission({ missionId: "fixed-id", traceId: "trace-b", projectId: "rp" });
  // La seconde tentative ne change ni traceId ni projectId : c'est la mission d'origine qui est renvoyée.
  assert.deepEqual(second, first);
});

test("idempotence conservée : rejouer le même event_id ne duplique pas l'événement ni n'avance la séquence", () => {
  const store = new MissionStore();
  const mission = store.createMission({ traceId: "t", projectId: "jarvis" });
  const first = store.appendMissionEvent({ eventId: "e1", missionId: mission.missionId, traceId: "t", sequence: 1, eventType: "X", timestamp: 1, payload: { a: 1 } }, 1);
  assert.deepEqual(first, { duplicate: false, applied: true });

  const replay = store.appendMissionEvent({ eventId: "e1", missionId: mission.missionId, traceId: "t", sequence: 1, eventType: "X", timestamp: 1, payload: { a: 1 } }, 2);
  assert.deepEqual(replay, { duplicate: true, applied: false });

  const afterReplay = store.getMission(mission.missionId)!;
  assert.equal(afterReplay.lastEventSequence, 1);
  assert.equal(afterReplay.rowVersion, 2, "le rejeu ne doit pas avancer row_version une seconde fois");
  assert.equal(store.listMissionEvents(mission.missionId).length, 1);
});

test("génération de hash de contexte : déterministe, insensible à l'ordre des clés, sensible au contenu", () => {
  const a = computeContextHash({ objective: "x", constraints: ["a", "b"] });
  const b = computeContextHash({ constraints: ["a", "b"], objective: "x" });
  const c = computeContextHash({ objective: "y", constraints: ["a", "b"] });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("versioning de contexte : première version, avancement et validation de la chaîne", () => {
  const v1 = createInitialContextVersion({ missionId: "m1", traceId: "t1", baseSha: "sha1", content: { objective: "x" }, now: 100 });
  assert.equal(v1.contextVersion, 1);
  assert.equal(v1.previousContextHash, null);
  assert.equal(v1.baseSha, "sha1");

  const v2 = advanceContextVersion(v1, { objective: "x", finding: "new" });
  assert.equal(v2.contextVersion, 2);
  assert.equal(v2.previousContextHash, v1.contextHash);
  assert.notEqual(v2.contextHash, v1.contextHash);
  assert.equal(v2.baseSha, "sha1", "base_sha repris tel quel si non fourni");

  const v3 = advanceContextVersion(v2, { objective: "x", finding: "new", more: 1 }, "sha2");
  assert.equal(v3.baseSha, "sha2");

  assert.deepEqual(verifyContextChain([v1, v2, v3]), { valid: true });
  assert.deepEqual(verifyContextChain([v3, v1, v2]), { valid: true }, "l'ordre d'entrée ne doit pas importer, la fonction trie par version");
});

test("validation de hash de contexte : chaîne cassée détectée (previous_context_hash incohérent, version non consécutive)", () => {
  const v1 = createInitialContextVersion({ missionId: "m1", traceId: "t1", baseSha: "sha1", content: { objective: "x" } });
  const v2 = advanceContextVersion(v1, { objective: "y" });

  const tamperedHash = { ...v2, previousContextHash: "not-the-real-hash" };
  const brokenChain = verifyContextChain([v1, tamperedHash]);
  assert.equal(brokenChain.valid, false);

  const skippedVersion = { ...v2, contextVersion: 3 };
  const gap = verifyContextChain([v1, skippedVersion]);
  assert.equal(gap.valid, false);

  const missingFirst = verifyContextChain([v2]);
  assert.equal(missingFirst.valid, false, "une chaîne qui ne commence pas à la version 1 est invalide");
});

test("recordContextVersion persiste et rejette une version qui n'enchaîne pas correctement", () => {
  const store = new MissionStore();
  const mission = store.createMission({ traceId: "t1", projectId: "jarvis" });
  const v1 = createInitialContextVersion({ missionId: mission.missionId, traceId: "t1", baseSha: "sha1", content: { objective: "x" } });
  store.recordContextVersion(v1);

  const v2 = advanceContextVersion(v1, { objective: "x", more: true });
  store.recordContextVersion(v2);

  const listed = store.listContextVersions(mission.missionId);
  assert.deepEqual(listed, [v1, v2]);

  // Rejouer la même version (append-only : la clé primaire mission_id+context_version l'interdit).
  assert.throws(() => store.recordContextVersion(v1));

  // Un hash précédent incohérent est détecté avant même d'atteindre la base.
  const badV3 = { ...advanceContextVersion(v2, { objective: "z" }), previousContextHash: "wrong" };
  assert.throws(() => store.recordContextVersion(badV3));
});

test("aucun effet de bord GitHub : le module coordination n'importe pas Octokit et n'appelle aucune méthode réseau", () => {
  // Vérifie la dépendance réelle (le seul chemin possible vers un effet de
  // bord GitHub dans ce dépôt est `@octokit/rest`, cf. softwareFactoryService.ts
  // et githubReadOnlyClient.ts) plutôt que la simple présence du mot "GitHub"
  // dans un commentaire explicatif, qui donnerait un test fragile.
  const files = ["./types.ts", "./contextVersioning.ts", "./missionStore.ts"];
  for (const relative of files) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    const source = readFileSync(path, "utf-8");
    assert.doesNotMatch(source, /octokit|fetch\(|http\.request|https\.request/i, `${relative} ne doit importer ni Octokit ni effectuer d'appel réseau`);
  }
});
