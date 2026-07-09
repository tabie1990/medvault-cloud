import { env } from '../config/env.js';

const GRAPH_API_VERSION = 'v20.0';

function apiConfigured(): boolean {
  return Boolean(env.whatsappAccessToken && env.whatsappPhoneNumberId);
}

/**
 * Sends a plain text WhatsApp message. Only valid within Meta's 24-hour
 * customer-initiated session window — anything sent outside that window
 * (proactive reminders, results-ready pings) must use a pre-approved message
 * template instead. See sendTemplateMessage below.
 */
export async function sendTextMessage(to: string, body: string): Promise<void> {
  if (!apiConfigured()) {
    console.log(`[whatsapp:dev-mode] would send to ${to}: ${body}`);
    return;
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${env.whatsappPhoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.whatsappAccessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`whatsapp_send_failed: ${res.status} ${text}`);
  }
}

/**
 * Sends a pre-approved template message — required for anything you initiate
 * (as opposed to replying inside a customer's open 24h session). Configure
 * template names/params to match whatever you've had approved in the Meta
 * dashboard for appointment confirmations, lab-result-ready notices, etc.
 */
export async function sendTemplateMessage(
  to: string,
  templateName: string,
  languageCode: string,
  params: string[] = []
): Promise<void> {
  if (!apiConfigured()) {
    console.log(`[whatsapp:dev-mode] would send template ${templateName} to ${to}:`, params);
    return;
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${env.whatsappPhoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.whatsappAccessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: params.length
          ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
          : []
      }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`whatsapp_template_send_failed: ${res.status} ${text}`);
  }
}

export function verifyWebhookChallenge(query: Record<string, unknown>): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token === env.whatsappVerifyToken && typeof challenge === 'string') {
    return challenge;
  }
  return null;
}

export interface InboundWhatsAppMessage {
  from: string;
  text: string;
}

/** Parses Meta's webhook payload shape down to the parts we care about. */
export function parseInboundMessages(body: any): InboundWhatsAppMessage[] {
  const messages: InboundWhatsAppMessage[] = [];
  const entries = body?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      for (const msg of change?.value?.messages ?? []) {
        if (msg.type === 'text' && msg.text?.body) {
          messages.push({ from: msg.from, text: msg.text.body });
        }
      }
    }
  }
  return messages;
}
