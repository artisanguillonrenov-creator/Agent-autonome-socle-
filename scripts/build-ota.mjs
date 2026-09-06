import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const wwwDir = join(rootDir, "www");

// 1. Target files to bundle
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

// 3. Calculate SHA-256
const sha256 = createHash("sha256").update(bundlePayload).digest("hex");

// 4. Create Manifest
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8"));
const otaVersion = process.env.OTA_VERSION || "1.0.1";
const minNativeVersion = process.env.MIN_NATIVE_VERSION || "1.0.0";

const manifest = {
  version: otaVersion,
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
console.log(`[OTA Build] Version: ${manifest.version} | SHA256: ${sha256.slice(0, 12)}...`);
