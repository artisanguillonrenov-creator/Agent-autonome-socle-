import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const wwwDir = join(rootDir, "www");

// The conversation manager must be present in fresh Web/Capacitor builds AND in OTA
// updates. Keep the historical OTA payload limited to index/style/app by embedding the
// current manager directly into the generated index.html. This way the bundle remains an
// exact snapshot of the files currently present in www/ and otaClient.test.ts can verify
// its hash without any hidden post-processing.
const indexPath = join(wwwDir, "index.html");
const conversationBootstrapPath = join(wwwDir, "conversationPersistence.js");
if (existsSync(indexPath) && existsSync(conversationBootstrapPath)) {
  const beginMarker = "<!-- JARVIS_CONVERSATION_MANAGER_BEGIN -->";
  const endMarker = "<!-- JARVIS_CONVERSATION_MANAGER_END -->";
  const conversationManager = readFileSync(conversationBootstrapPath, "utf-8");
  let indexHtml = readFileSync(indexPath, "utf-8");

  // Idempotent rebuild: remove a previously generated inline block and any historical
  // external 11A/11B script tag before writing the current source again.
  indexHtml = indexHtml.replace(
    /<!-- JARVIS_CONVERSATION_MANAGER_BEGIN -->[\s\S]*?<!-- JARVIS_CONVERSATION_MANAGER_END -->\s*/g,
    "",
  );
  indexHtml = indexHtml.replace(
    /<script\b[^>]*\bsrc=["']conversationPersistence\.js["'][^>]*><\/script>\s*/gi,
    "",
  );

  const inlineBootstrap = `${beginMarker}\n<script data-jarvis-conversation-bootstrap="11b">\n${conversationManager}\n</script>\n${endMarker}`;
  if (indexHtml.includes("</body>")) {
    indexHtml = indexHtml.replace("</body>", `  ${inlineBootstrap}\n</body>`);
    writeFileSync(indexPath, indexHtml, "utf-8");
  }
}

// 1. Target files to bundle. The OTA contract intentionally remains these three files.
const filesToBundle = ["index.html", "style.css", "app.js"];
const bundleFilesMap = {};

for (const file of filesToBundle) {
  const filePath = join(wwwDir, file);
  if (existsSync(filePath)) {
    bundleFilesMap[file] = readFileSync(filePath, "utf-8");
  }
}

// 2. Package bundle payload
const bundlePayload = JSON.stringify({ files: bundleFilesMap }, null, 2);
const bundlePath = join(wwwDir, "ota-bundle.json");
writeFileSync(bundlePath, bundlePayload, "utf-8");

// 3. Calculate SHA-256 — c'est cet identifiant, pas un numéro de version saisi à la
// main, qui fait foi pour savoir si un bundle a réellement changé.
const sha256 = createHash("sha256").update(bundlePayload).digest("hex");

function resolveBuildId() {
  const fromEnv =
    process.env.OTA_BUILD_ID ||
    process.env.RENDER_GIT_COMMIT ||
    process.env.GITHUB_SHA ||
    process.env.SOURCE_VERSION ||
    null;
  if (fromEnv) return fromEnv.slice(0, 12);

  try {
    const gitSha = execSync("git rev-parse HEAD", { cwd: rootDir }).toString().trim();
    if (gitSha) return gitSha.slice(0, 12);
  } catch {
    // Pas de dépôt git disponible (ex: build depuis un tarball) : on retombe sur le hash.
  }

  return sha256.slice(0, 12);
}

const buildId = resolveBuildId();

// 4. Create Manifest
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8"));
const otaVersion = process.env.OTA_VERSION || packageJson.version;
const minNativeVersion = process.env.MIN_NATIVE_VERSION || "1.0.0";

const manifest = {
  version: otaVersion,
  buildId,
  build: Date.now(),
  minimumNativeVersion: minNativeVersion,
  bundleUrl: "/api/ota/bundle",
  sha256: sha256,
  releaseNotes: "Mise à jour OTA Command Center - Améliorations visuelles et fonctionnelles.",
  updatedAt: new Date().toISOString(),
};

const manifestPath = join(wwwDir, "ota-manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

console.log(`[OTA Build] Succès ! Manifeste généré à : ${manifestPath}`);
console.log(`[OTA Build] Version: ${manifest.version} | BuildId: ${buildId} | SHA256: ${sha256.slice(0, 12)}...`);
