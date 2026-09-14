import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, isSensitivePath, scanForSecrets } from "./secretScanner.js";

test("redactSecrets masque les jetons GitHub, AWS, Slack, OpenAI, JWT et clés privées", () => {
  const cases = [
    "token=ghp_1234567890abcdefghij1234567890",
    "AKIAABCDEFGHIJKLMNOP is an AWS key",
    "xoxb-FAKETESTTOKENNOTREAL-abcdefghijklmnop",
    "sk-abcdefghijklmnopqrstuvwxyz123456",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    "Authorization: Bearer abcdef1234567890ghijklm",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj\n-----END RSA PRIVATE KEY-----",
    'apiKey: "sk_live_abcdefghijklmnop"',
  ];
  for (const input of cases) {
    const { text, redactedCount } = redactSecrets(input);
    assert.ok(redactedCount > 0, `should redact: ${input}`);
    assert.ok(text.includes("[REDACTED_SECRET]"), `should mask: ${input}`);
  }
});

test("redactSecrets laisse intact du texte ordinaire", () => {
  const input = "function add(a, b) { return a + b; } // simple utility, no secrets here";
  const { text, redactedCount } = redactSecrets(input);
  assert.equal(redactedCount, 0);
  assert.equal(text, input);
});

test("redactSecrets est idempotent sur des appels répétés (regex globales réinitialisées)", () => {
  const input = "token=ghp_1234567890abcdefghij1234567890 and again token=ghp_abcdefghijklmnopqrst1234567890";
  const first = redactSecrets(input);
  const second = redactSecrets(input);
  assert.equal(first.redactedCount, second.redactedCount);
  assert.equal(first.text, second.text);
});

test("isSensitivePath bloque les fichiers de secrets/clés connus", () => {
  for (const p of [".env", "config/.env.production", ".npmrc", "id_rsa", "keys/id_ed25519.pub", "server.pem", "cert.key", "credentials.json", "config/secrets.yml", ".git-credentials", "service-account-prod.json"]) {
    assert.equal(isSensitivePath(p), true, p);
  }
});

test("isSensitivePath n'exclut pas les fichiers de code ordinaires", () => {
  for (const p of ["src/index.ts", "README.md", "package.json", "docs/keyboard-shortcuts.md", "src/environment.ts"]) {
    assert.equal(isSensitivePath(p), false, p);
  }
});

test("scanForSecrets : contenu propre ne détecte rien", () => {
  const result = scanForSecrets("function add(a, b) { return a + b; }", "Instructions normales, rien de sensible.");
  assert.equal(result.detected, false);
  assert.equal(result.redactedCount, 0);
});

test("scanForSecrets : détecte un secret dans n'importe lequel des textes fournis", () => {
  const result = scanForSecrets("code propre", "GITHUB_TOKEN=ghp_1234567890abcdefghij1234567890");
  assert.equal(result.detected, true);
  assert.equal(result.redactedCount, 1);
});

test("scanForSecrets : ne renvoie jamais le texte original quand un secret est détecté", () => {
  const secret = "ghp_1234567890abcdefghij1234567890";
  const result = scanForSecrets(`token=${secret}`);
  assert.equal(result.safePreview.includes(secret), false);
  assert.ok(result.safePreview.includes("[REDACTED_SECRET]"));
});

test("scanForSecrets : agrège le compte sur plusieurs textes", () => {
  const result = scanForSecrets("token=ghp_1234567890abcdefghij1234567890", "AKIAABCDEFGHIJKLMNOP");
  assert.equal(result.redactedCount, 2);
});
