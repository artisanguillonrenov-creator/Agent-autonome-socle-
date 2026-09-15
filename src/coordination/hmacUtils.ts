import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Vérification sécurisée d'une signature HMAC-SHA256.
 * Utilise une comparaison à temps constant pour éviter les attaques par chronométrage.
 */
export function verifyHmac(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}