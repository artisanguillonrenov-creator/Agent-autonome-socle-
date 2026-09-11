import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const wwwDir = join(rootDir, "www");

// 1. Target files to bundle. Chantier 11A keeps its continuity shim as a separate
// asset for the native/base app, while the OTA index gets the same code inlined so a
// document.write() reload of an OTA index cannot silently lose conversation persistence.
const filesToBundle = ["index.html", "style.css", "app.js", "conversationPersistence.js"];
const bundleFilesMap = {};
const conversationBootstrapPath = join(wwwDir, "conversationPersistence.js");
const conversationBootstrap = existsSync(conversationBootstrapPath)
  ? readFileSync(conversationBootstrapPath, "utf-8")
  : "";

for (const file of filesToBundle) {
  const filePath = join(wwwDir, file);
  if (!existsSync(filePath)) continue;
  let content = readFileSync(filePath, "utf-8");
  if (file === "index.html" && conversationBootstrap) {
    const marker = "data-jarvis-conversation-bootstrap=\"11a\"";
    if (!content.includes(marker)) {
      content = content.replace(
        "</body>",
        `<script ${marker}>\n${conversationBootstrap}\n</script>\n</body>`,
      );
    }
  }
  bundleFilesMap[file] = content;
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
