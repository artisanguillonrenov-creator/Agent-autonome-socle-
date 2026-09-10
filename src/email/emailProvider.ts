import { config } from "../config.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/**
 * Aucun fournisseur e-mail réel configuré : échoue explicitement, ne prétend jamais
 * qu'un envoi a réussi (commercial_office_send / activity.emailAlerts).
 */
export class NoopEmailProvider implements EmailProvider {
  async send(): Promise<EmailSendResult> {
    return { ok: false, error: "EMAIL_PROVIDER_NOT_CONFIGURED" };
  }
}

/**
 * Provider générique/agnostique : POST JSON {to,subject,text} vers n'importe quel
 * endpoint HTTP configuré par l'utilisateur (relais SMTP, fonction serverless, ou API
 * d'un fournisseur transactionnel compatible). Aucune dépendance à un fournisseur
 * commercial spécifique — voir EMAIL_WEBHOOK_URL/EMAIL_WEBHOOK_TOKEN.
 */
export class WebhookEmailProvider implements EmailProvider {
  constructor(private readonly url: string, private readonly token?: string, private readonly timeoutMs = 10000) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!message.to || !message.to.trim()) return { ok: false, error: "EMAIL_RECIPIENT_MISSING" };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      const res = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, error: `EMAIL_WEBHOOK_HTTP_${res.status}` };
      let id: string | undefined;
      try {
        const body = (await res.json()) as { id?: string };
        id = typeof body?.id === "string" ? body.id : undefined;
      } catch {
        // Réponse non-JSON acceptée tant que le statut HTTP est OK.
      }
      return { ok: true, id };
    } catch (e) {
      const err = e as Error;
      return { ok: false, error: err.name === "AbortError" ? "EMAIL_WEBHOOK_TIMEOUT" : `EMAIL_WEBHOOK_ERROR: ${err.message}` };
    }
  }
}

export function createEmailProvider(): EmailProvider {
  if (!config.email.webhookUrl) return new NoopEmailProvider();
  return new WebhookEmailProvider(config.email.webhookUrl, config.email.webhookToken || undefined);
}
