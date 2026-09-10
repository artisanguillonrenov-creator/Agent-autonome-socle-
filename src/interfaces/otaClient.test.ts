import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";

/**
 * Fabrique une sandbox vm neuve pour www/app.js, façon httpApi.test.ts : un `require`
 * du fichier réel exécuté dans un contexte navigateur minimal (localStorage/document en
 * mémoire), pas une réimplémentation séparée de la logique OTA — sinon le test pourrait
 * passer alors même que le code réellement livré serait cassé.
 */
function loadAppJsSandbox(initialLocalStorage: Record<string, string> = {}) {
  const store = { ...initialLocalStorage };
  const localStorage = {
    getItem: (key: string) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };

  const dummyElement = {
    style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {},
    getAttribute: () => "accueil",
    querySelector: () => ({ textContent: "Accueil" }),
    innerHTML: "",
  };

  const contextObj: Record<string, unknown> = {
    document: {
      readyState: "loading",
      getElementById: () => dummyElement,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    localStorage,
    window: {},
    console,
    setTimeout,
    clearTimeout,
    crypto,
    TextEncoder,
    fetch: async () => jsonResponse({}),
  };

  vm.createContext(contextObj);
  const appJsCode = fs.readFileSync(path.join(process.cwd(), "www", "app.js"), "utf-8");
  vm.runInContext(appJsCode, contextObj);

  return { ctx: contextObj, store, api: contextObj.window as any };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
  };
}

test("OTA: le bundle et le manifest servis par Render correspondent au code Web courant", async () => {
  const wwwDir = path.join(process.cwd(), "www");
  const files: Record<string, string> = {};
  for (const file of ["index.html", "style.css", "app.js"]) {
    const p = path.join(wwwDir, file);
    if (fs.existsSync(p)) files[file] = fs.readFileSync(p, "utf-8");
  }
  const bundleString = JSON.stringify({ files }, null, 2);
  const expectedSha256 = sha256(bundleString);

  const manifestPath = path.join(wwwDir, "ota-manifest.json");
  const bundlePath = path.join(wwwDir, "ota-bundle.json");
  assert.ok(fs.existsSync(manifestPath), "www/ota-manifest.json doit être généré (npm run build → scripts/build-ota.mjs)");
  assert.ok(fs.existsSync(bundlePath), "www/ota-bundle.json doit être généré (npm run build → scripts/build-ota.mjs)");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const servedBundleText = fs.readFileSync(bundlePath, "utf-8");

  assert.equal(sha256(servedBundleText).toLowerCase(), manifest.sha256.toLowerCase(), "le SHA-256 du bundle servi doit correspondre au manifest");
  assert.equal(manifest.sha256.toLowerCase(), expectedSha256.toLowerCase(), "le bundle généré doit correspondre au code Web actuellement présent dans www/");
  assert.ok(manifest.buildId && String(manifest.buildId).length > 0, "le manifest doit porter un identifiant de build unique");

  const servedBundle = JSON.parse(servedBundleText);
  for (const file of Object.keys(files)) {
    assert.equal(servedBundle.files[file], files[file], `${file} du bundle OTA doit être identique au fichier www/${file} déployé`);
  }
});

test("OTA: aucune version fixe par défaut n'est câblée dans le pipeline de build", () => {
  const buildScript = fs.readFileSync(path.join(process.cwd(), "scripts", "build-ota.mjs"), "utf-8");
  assert.doesNotMatch(buildScript, /["']1\.1\.0["']/, "le script de build ne doit plus dépendre d'une version OTA fixe");

  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
  assert.match(pkg.scripts.build, /build-ota\.mjs/, "le build réellement exécuté par Render doit régénérer les fichiers OTA");
});

test("OTA: un nouveau bundle (buildId différent) est détecté", async () => {
  const { ctx, store, api } = loadAppJsSandbox({
    jarvis_ota_active_version: "1.0.0",
    jarvis_ota_active_build_id: "build-aaa",
    jarvis_ota_active_sha256: "aaa",
  });

  (ctx as any).fetch = async () =>
    jsonResponse({
      version: "1.2.0",
      buildId: "build-bbb",
      sha256: "bbb",
      minimumNativeVersion: "1.0.0",
      releaseNotes: "test",
    });

  const manifest = await api.checkOtaUpdates(false);
  assert.ok(manifest, "une mise à jour doit être détectée quand le buildId diffère");
  assert.equal(manifest.buildId, "build-bbb");
  assert.equal(store.jarvis_ota_active_build_id, "build-aaa", "checkOtaUpdates seul ne doit pas installer la mise à jour");
});

test("OTA: le même bundle actif est ignoré (pas de boucle de réinstallation)", async () => {
  const { ctx, api } = loadAppJsSandbox({
    jarvis_ota_active_version: "1.2.0",
    jarvis_ota_active_build_id: "build-bbb",
    jarvis_ota_active_sha256: "bbb",
  });

  (ctx as any).fetch = async () =>
    jsonResponse({
      version: "1.2.0",
      buildId: "build-bbb",
      sha256: "bbb",
      minimumNativeVersion: "1.0.0",
      releaseNotes: "test",
    });

  const manifest = await api.checkOtaUpdates(false);
  assert.equal(manifest, null, "un manifest dont l'identité correspond déjà au bundle actif ne doit déclencher aucune mise à jour");
});

test("OTA: un bundle au SHA-256 invalide est refusé et n'est jamais installé", async () => {
  const { ctx, store, api } = loadAppJsSandbox({
    jarvis_ota_active_version: "1.0.0",
    jarvis_ota_active_build_id: "build-aaa",
    jarvis_ota_active_sha256: "aaa",
  });

  const tamperedBundle = JSON.stringify({ files: { "app.js": "// altéré en transit" } });
  (ctx as any).fetch = async (url: string) => {
    if (String(url).includes("/api/ota/manifest")) {
      return jsonResponse({
        version: "2.0.0",
        buildId: "build-ccc",
        sha256: "0000000000000000000000000000000000000000000000000000000000000",
        minimumNativeVersion: "1.0.0",
        releaseNotes: "test",
      });
    }
    return { ok: true, text: async () => tamperedBundle };
  };
  (ctx as any).alert = () => {};

  await api.applyOtaUpdate();

  assert.equal(store.jarvis_ota_active_build_id, "build-aaa", "l'installation doit être annulée sur échec de vérification SHA-256");
  assert.equal(store.jarvis_ota_active_version, "1.0.0");
});

test("OTA: un bundle valide est installé puis recharge l'application", async () => {
  const { ctx, store, api } = loadAppJsSandbox({
    jarvis_ota_active_version: "1.0.0",
    jarvis_ota_active_build_id: "build-aaa",
    jarvis_ota_active_sha256: "aaa",
    jarvis_ota_active_bundle: JSON.stringify({ files: { "app.js": "// v1" } }),
  });

  const newBundleString = JSON.stringify({ files: { "app.js": "// v2" } });
  const validSha256 = sha256(newBundleString);

  (ctx as any).fetch = async (url: string) => {
    if (String(url).includes("/api/ota/manifest")) {
      return jsonResponse({
        version: "2.0.0",
        buildId: "build-ddd",
        sha256: validSha256,
        minimumNativeVersion: "1.0.0",
        releaseNotes: "test",
      });
    }
    return { ok: true, text: async () => newBundleString };
  };
  (ctx as any).alert = () => {};

  let reloaded = false;
  (ctx.window as any).location = { reload: () => { reloaded = true; } };

  await api.applyOtaUpdate();

  assert.equal(reloaded, true, "une installation réussie doit recharger l'application sur la nouvelle version");
  assert.equal(store.jarvis_ota_active_build_id, "build-ddd");
  assert.equal(store.jarvis_ota_active_sha256, validSha256);
  assert.equal(store.jarvis_ota_active_version, "2.0.0");
  assert.equal(store.jarvis_ota_previous_build_id, "build-aaa", "l'ancien build doit être conservé pour permettre un rollback");
  assert.equal(store.jarvis_ota_previous_version, "1.0.0");
});

test("OTA: le rollback restaure la version précédente et reste fonctionnel", async () => {
  const { ctx, store, api } = loadAppJsSandbox({
    jarvis_ota_active_version: "2.0.0",
    jarvis_ota_active_build_id: "build-ddd",
    jarvis_ota_active_sha256: "ddd",
    jarvis_ota_active_bundle: JSON.stringify({ files: { "app.js": "// v2" } }),
    jarvis_ota_previous_version: "1.0.0",
    jarvis_ota_previous_build_id: "build-aaa",
    jarvis_ota_previous_sha256: "aaa",
    jarvis_ota_previous_bundle: JSON.stringify({ files: { "app.js": "// v1" } }),
  });

  (ctx as any).confirm = () => true;
  (ctx as any).alert = () => {};
  let reloaded = false;
  (ctx.window as any).location = { reload: () => { reloaded = true; } };

  api.rollbackOtaUpdate();

  assert.equal(reloaded, true);
  assert.equal(store.jarvis_ota_active_version, "1.0.0");
  assert.equal(store.jarvis_ota_active_build_id, "build-aaa");
  assert.equal(store.jarvis_ota_active_sha256, "aaa");
  assert.equal(store.jarvis_ota_previous_version, undefined, "les données de rollback consommées doivent être nettoyées");
});

test("OTA: les anciennes installations (clés jarvis_ota_* historiques) sont migrées sans réinstallation en boucle", async () => {
  const legacyBundle = JSON.stringify({ files: { "app.js": "// legacy" } });
  const { store, api } = loadAppJsSandbox({
    jarvis_ota_active_version: "1.1.0",
    jarvis_ota_active_bundle: legacyBundle,
  });

  assert.equal(store.jarvis_ota_active_build_id, undefined, "avant migration, aucune identité de build n'existe encore");

  await api.migrateLegacyOtaState();

  const expectedId = sha256(legacyBundle);
  assert.equal(store.jarvis_ota_active_build_id, expectedId, "une identité stable est dérivée du bundle déjà installé");
  assert.equal(store.jarvis_ota_active_sha256, expectedId);

  const manifestSameIdentity = { version: "1.1.0", buildId: expectedId, sha256: expectedId };
  assert.equal(api.getOtaManifestIdentity(manifestSameIdentity), api.getActiveOtaIdentity(), "après migration, un manifest identique au bundle déjà installé ne doit pas déclencher de réinstallation");
});
