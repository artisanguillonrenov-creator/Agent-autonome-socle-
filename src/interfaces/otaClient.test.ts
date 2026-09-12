import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// C.3 (directives de correction) : scripts/build-ota.mjs tournait auparavant en pretest
// npm, donc à CHAQUE lancement de `npm test` — y compris pour les 500+ tests backend qui
// n'en dépendent pas — et mutait des fichiers suivis par git (www/index.html,
// ota-manifest.json, ota-bundle.json) sur chaque exécution. Seul ce fichier a réellement
// besoin d'un www/ota-*.json à jour : on l'exécute donc ici, une seule fois, avant les
// tests qui en dépendent.
before(() => {
  execFileSync(process.execPath, [path.join(process.cwd(), "scripts", "build-ota.mjs")], { stdio: "inherit" });
});

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

  let reloaded = false;
  const documentWriteCalls: string[] = [];

  const contextObj: Record<string, unknown> = {
    document: {
      readyState: "loading",
      getElementById: () => dummyElement,
      querySelectorAll: () => [],
      addEventListener: () => {},
      open: () => {},
      write: (html: string) => documentWriteCalls.push(html),
      close: () => {},
    },
    localStorage,
    window: { location: { reload: () => { reloaded = true; } } },
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

  return {
    ctx: contextObj,
    store,
    api: contextObj.window as any,
    wasReloaded: () => reloaded,
    documentWriteCalls,
  };
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

function mockOtaFetch(ctx: Record<string, unknown>, manifest: unknown, bundleString: string, calls: { manifest: number; bundle: number } = { manifest: 0, bundle: 0 }) {
  (ctx as any).fetch = async (url: string) => {
    if (String(url).includes("/api/ota/manifest")) {
      calls.manifest++;
      return jsonResponse(manifest);
    }
    calls.bundle++;
    return { ok: true, text: async () => bundleString };
  };
  return calls;
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

test("OTA: un nouveau bundle compatible est détecté ET installé automatiquement au démarrage, sans aucun clic", async () => {
  const { ctx, store, api, wasReloaded } = loadAppJsSandbox({
    jarvis_ota_active_version: "1.0.0",
    jarvis_ota_active_build_id: "build-aaa",
    jarvis_ota_active_sha256: "aaa",
  });

  const newBundleString = JSON.stringify({ files: { "app.js": "// v2 auto" } });
  const validSha256 = sha256(newBundleString);
  const calls = mockOtaFetch(
    ctx,
    { version: "1.2.0", buildId: "build-bbb", sha256: validSha256, minimumNativeVersion: "1.0.0", releaseNotes: "test" },
    newBundleString,
  );

  // Seul checkOtaUpdates(false) est appelé — exactement ce que déclenche le démarrage
  // automatique de l'app (bootstrapJarvis). Aucun clic ni appel à applyOtaUpdate().
  const manifest = await api.checkOtaUpdates(false);

  assert.ok(manifest, "la vérification automatique doit rapporter le manifest trouvé");
  assert.equal(calls.manifest, 1, "le manifest doit être consulté automatiquement au démarrage");
  assert.equal(calls.bundle, 1, "le bundle doit être téléchargé automatiquement, sans action de l'utilisateur");
  assert.equal(store.jarvis_ota_active_build_id, "build-bbb", "le nouveau bundle doit être installé automatiquement");
  assert.equal(store.jarvis_ota_active_sha256, validSha256);
  assert.equal(store.jarvis_ota_active_version, "1.2.0");
  assert.equal(store.jarvis_ota_previous_build_id, "build-aaa", "l'ancien bundle doit être conservé pour un rollback");
  assert.equal(wasReloaded(), true, "l'application doit recharger automatiquement sur la nouvelle version");
});

test("OTA: un bundle déjà actif n'est jamais retéléchargé ni réinstallé (pas de boucle)", async () => {
  const { ctx, store, api, wasReloaded } = loadAppJsSandbox({
    jarvis_ota_active_version: "1.2.0",
    jarvis_ota_active_build_id: "build-bbb",
    jarvis_ota_active_sha256: "bbb",
  });

  const calls = mockOtaFetch(
    ctx,
    { version: "1.2.0", buildId: "build-bbb", sha256: "bbb", minimumNativeVersion: "1.0.0", releaseNotes: "test" },
    JSON.stringify({ files: { "app.js": "// inchangé" } }),
  );

  const manifest = await api.checkOtaUpdates(false);

  assert.equal(manifest, null, "un manifest dont l'identité correspond déjà au bundle actif ne doit déclencher aucune mise à jour");
  assert.equal(calls.bundle, 0, "le bundle ne doit même pas être retéléchargé si son identité est déjà active");
  assert.equal(store.jarvis_ota_active_build_id, "build-bbb", "le bundle actif ne doit pas changer");
  assert.equal(wasReloaded(), false, "aucun rechargement ne doit avoir lieu quand rien n'a changé");
});

test("OTA: un hash invalide bloque l'installation automatique, l'ancienne version reste active", async () => {
  const { ctx, store, api, wasReloaded } = loadAppJsSandbox({
    jarvis_ota_active_version: "1.0.0",
    jarvis_ota_active_build_id: "build-aaa",
    jarvis_ota_active_sha256: "aaa",
  });

  const tamperedBundle = JSON.stringify({ files: { "app.js": "// altéré en transit" } });
  mockOtaFetch(
    ctx,
    {
      version: "2.0.0",
      buildId: "build-ccc",
      sha256: "0000000000000000000000000000000000000000000000000000000000000",
      minimumNativeVersion: "1.0.0",
      releaseNotes: "test",
    },
    tamperedBundle,
  );

  const manifest = await api.checkOtaUpdates(false);

  assert.equal(manifest, null, "une installation automatique refusée ne doit pas être rapportée comme réussie");
  assert.equal(store.jarvis_ota_active_build_id, "build-aaa", "l'installation automatique doit être annulée sur échec SHA-256");
  assert.equal(store.jarvis_ota_active_version, "1.0.0");
  assert.equal(wasReloaded(), false, "aucun rechargement ne doit survenir si le hash est invalide");
});

test("OTA: un hash invalide bloque aussi une installation manuelle (écran Système)", async () => {
  const { ctx, store, api, wasReloaded } = loadAppJsSandbox({
    jarvis_ota_active_version: "1.0.0",
    jarvis_ota_active_build_id: "build-aaa",
    jarvis_ota_active_sha256: "aaa",
  });

  const tamperedBundle = JSON.stringify({ files: { "app.js": "// altéré en transit" } });
  mockOtaFetch(
    ctx,
    {
      version: "2.0.0",
      buildId: "build-ccc",
      sha256: "0000000000000000000000000000000000000000000000000000000000000",
      minimumNativeVersion: "1.0.0",
      releaseNotes: "test",
    },
    tamperedBundle,
  );
  (ctx as any).alert = () => {};

  await api.applyOtaUpdate();

  assert.equal(store.jarvis_ota_active_build_id, "build-aaa", "l'installation manuelle doit être annulée sur échec de vérification SHA-256");
  assert.equal(store.jarvis_ota_active_version, "1.0.0");
  assert.equal(wasReloaded(), false);
});

test("OTA: un bundle valide déclenche un reload (repli window.location.reload si le bundle n'embarque pas index.html)", async () => {
  const { ctx, store, api, wasReloaded } = loadAppJsSandbox({
    jarvis_ota_active_version: "1.0.0",
    jarvis_ota_active_build_id: "build-aaa",
    jarvis_ota_active_sha256: "aaa",
    jarvis_ota_active_bundle: JSON.stringify({ files: { "app.js": "// v1" } }),
  });

  const newBundleString = JSON.stringify({ files: { "app.js": "// v2" } });
  const validSha256 = sha256(newBundleString);
  mockOtaFetch(ctx, { version: "2.0.0", buildId: "build-ddd", sha256: validSha256, minimumNativeVersion: "1.0.0", releaseNotes: "test" }, newBundleString);
  (ctx as any).alert = () => {};

  await api.applyOtaUpdate();

  assert.equal(wasReloaded(), true, "une installation réussie doit recharger l'application sur la nouvelle version");
  assert.equal(store.jarvis_ota_active_build_id, "build-ddd");
  assert.equal(store.jarvis_ota_active_sha256, validSha256);
  assert.equal(store.jarvis_ota_active_version, "2.0.0");
  assert.equal(store.jarvis_ota_previous_build_id, "build-aaa", "l'ancien build doit être conservé pour permettre un rollback");
  assert.equal(store.jarvis_ota_previous_version, "1.0.0");
});

test("OTA: une modification de index.html est réellement appliquée (pas seulement style.css/app.js)", async () => {
  const { ctx, store, api, wasReloaded, documentWriteCalls } = loadAppJsSandbox({
    jarvis_ota_active_version: "1.0.0",
    jarvis_ota_active_build_id: "build-aaa",
    jarvis_ota_active_sha256: "aaa",
    jarvis_ota_active_bundle: JSON.stringify({ files: { "index.html": "<html>v1</html>", "style.css": "/* v1 */", "app.js": "// v1" } }),
  });

  const newIndexHtml = "<html><body>v2 avec nouvelle structure</body></html>";
  const newBundleString = JSON.stringify({ files: { "index.html": newIndexHtml, "style.css": "/* v2 */", "app.js": "// v2" } });
  const validSha256 = sha256(newBundleString);
  mockOtaFetch(ctx, { version: "2.0.0", buildId: "build-html", sha256: validSha256, minimumNativeVersion: "1.0.0", releaseNotes: "test" }, newBundleString);
  (ctx as any).alert = () => {};

  await api.applyOtaUpdate();

  assert.equal(store.jarvis_ota_active_build_id, "build-html", "le bundle contenant le nouveau index.html doit être installé");
  assert.deepEqual(documentWriteCalls, [newIndexHtml], "le nouveau index.html doit être réellement injecté via document.write, pas ignoré");
  assert.equal(wasReloaded(), false, "quand un index.html est disponible, on réécrit le document plutôt que d'appeler window.location.reload()");
});

test("OTA: le bootloader continue d'injecter style.css et app.js (non régression)", () => {
  const indexHtml = fs.readFileSync(path.join(process.cwd(), "www", "index.html"), "utf-8");
  assert.match(indexHtml, /bundle\.files\['style\.css'\]/, "le bootloader doit toujours injecter le style.css du bundle actif");
  assert.match(indexHtml, /bundle\.files\['app\.js'\]/, "le bootloader doit toujours injecter l'app.js du bundle actif");
});

test("OTA: le rollback restaure la version précédente (y compris index.html) et reste fonctionnel", async () => {
  const previousIndexHtml = "<html><body>v1</body></html>";
  const { ctx, store, api, wasReloaded, documentWriteCalls } = loadAppJsSandbox({
    jarvis_ota_active_version: "2.0.0",
    jarvis_ota_active_build_id: "build-ddd",
    jarvis_ota_active_sha256: "ddd",
    jarvis_ota_active_bundle: JSON.stringify({ files: { "index.html": "<html><body>v2</body></html>", "app.js": "// v2" } }),
    jarvis_ota_previous_version: "1.0.0",
    jarvis_ota_previous_build_id: "build-aaa",
    jarvis_ota_previous_sha256: "aaa",
    jarvis_ota_previous_bundle: JSON.stringify({ files: { "index.html": previousIndexHtml, "app.js": "// v1" } }),
  });

  (ctx as any).confirm = () => true;
  (ctx as any).alert = () => {};

  api.rollbackOtaUpdate();

  assert.equal(store.jarvis_ota_active_version, "1.0.0");
  assert.equal(store.jarvis_ota_active_build_id, "build-aaa");
  assert.equal(store.jarvis_ota_active_sha256, "aaa");
  assert.equal(store.jarvis_ota_previous_version, undefined, "les données de rollback consommées doivent être nettoyées");
  assert.deepEqual(documentWriteCalls, [previousIndexHtml], "le rollback doit réappliquer le index.html de la version précédente");
  assert.equal(wasReloaded(), false);
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
