import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const wwwDir = join(rootDir, "www");

// The conversation manager must be present in fresh Web/Capacitor builds.
const indexPath = join(wwwDir, "index.html");
const conversationBootstrapPath = join(wwwDir, "conversationPersistence.js");
if (existsSync(indexPath) && existsSync(conversationBootstrapPath)) {
  const tag = '<script src="conversationPersistence.js" data-jarvis-conversation-bootstrap="11b"></script>';
  const indexHtml = readFileSync(indexPath, "utf-8");
  if (!indexHtml.includes('data-jarvis-conversation-bootstrap=')) {
    writeFileSync(indexPath, indexHtml.replace("</body>", `  ${tag}\n</body>`), "utf-8");
  }
}

// 1. Historical OTA payload remains index/style/app. To make the separately maintained
// conversation manager OTA-updatable without breaking that contract, append its source to
// the bundled app.js. The manager has an idempotent boot guard, so the static script tag in
// a fresh APK cannot execute it twice.
const filesToBundle = ["index.html", "style.css", "app.js"];
const bundleFilesMap = {};

for (const file of filesToBundle) {
  const filePath = join(wwwDir, file);
  if (existsSync(filePath)) {
    bundleFilesMap[file] = readFileSync(filePath, "utf-8");
  }
}

if (typeof bundleFilesMap["app.js"] === "string" && existsSync(conversationBootstrapPath)) {
  const conversationManager = readFileSync(conversationBootstrapPath, "utf-8");
  bundleFilesMap["app.js"] += `\n\n/* Jarvis Conversation Manager — OTA bundled */\n${conversationManager}`;
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
