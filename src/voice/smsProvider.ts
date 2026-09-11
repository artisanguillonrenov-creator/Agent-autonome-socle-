import { config } from "../config.js";

export interface SmsAlert {
  to: string;
  text: string;
}

export interface SmsSendResult {
  ok: boolean;
  error?: string;
}

export interface SmsProvider {
  send(alert: SmsAlert): Promise<SmsSendResult>;
}

export class WebhookSmsProvider implements SmsProvider {
  async send(alert: SmsAlert): Promise<SmsSendResult> {
    if (!config.sms.webhookUrl || !config.sms.alertTo) {
      return { ok: false, error: "SMS_PROVIDER_NOT_CONFIGURED" };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(config.sms.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.sms.webhookToken ? { authorization: `Bearer ${config.sms.webhookToken}` } : {}),
        },
        body: JSON.stringify({ to: alert.to, text: alert.text }),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, error: `SMS_PROVIDER_HTTP_${response.status}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).name === "AbortError" ? "SMS_PROVIDER_TIMEOUT" : "SMS_PROVIDER_UNAVAILABLE" };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createSmsProvider(): SmsProvider {
  return new WebhookSmsProvider();
}
