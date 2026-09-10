/**
 * Détection et masquage best-effort de secrets dans du texte issu d'un dépôt
 * GitHub (contenu de fichier, patch, diff, corps de PR). Ne prétend pas être
 * exhaustif : c'est une dernière ligne de défense qui s'ajoute au blocage des
 * chemins de fichiers sensibles (voir isSensitivePath), jamais un substitut.
 */
export interface RedactionResult {
  text: string;
  redactedCount: number;
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN(?: RSA| EC| OPENSSH| DSA| PGP)? PRIVATE KEY-----[\s\S]*?-----END(?: RSA| EC| OPENSSH| DSA| PGP)? PRIVATE KEY-----/g,
  // Jetons GitHub (personal access token classique/fin, OAuth, app, refresh...).
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // Clés d'accès AWS.
  /A(?:KIA|SIA)[0-9A-Z]{16}/g,
  // Jetons Slack.
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  // Clés API génériques de type "sk-..." (OpenAI et compatibles).
  /sk-[A-Za-z0-9]{20,}/g,
  // Clés API Google.
  /AIza[0-9A-Za-z\-_]{35}/g,
  // JWT.
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // En-têtes d'autorisation.
  /Bearer\s+[A-Za-z0-9._-]{10,}/gi,
  // Affectations génériques "clé = valeur" pour des noms évoquant un secret.
  /(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd|pwd)\s*[:=]\s*["']?[^\s"'`]{6,}["']?/gi,
];

export function redactSecrets(text: string): RedactionResult {
  let redactedCount = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      redactedCount++;
      return "[REDACTED_SECRET]";
    });
  }
  return { text: out, redactedCount };
}

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /(^|\/)id_(rsa|dsa|ed25519|ecdsa)(\.pub)?$/i,
  /credentials(\.\w+)?$/i,
  /service[-_]?account.*\.json$/i,
  /secrets?\.(ya?ml|json|ts|js|env)$/i,
];

/** Fichiers dont le contenu n'est jamais renvoyé, quel que soit le contenu réel (clés, .env, etc.). */
export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}
