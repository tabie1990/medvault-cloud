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
  bodyParams: string[] = [],
  // Authentication-category templates (like the OTP one) come with an
  // automatic "Copy Code" button that needs the same code passed again,
  // separately, as its own component — not just reused from the body.
  // Utility templates (payment/reminder) have no button and don't pass this.
  buttonParams?: string[]
): Promise<void> {
  if (!apiConfigured()) {
    console.log(`[whatsapp:dev-mode] would send template ${templateName} to ${to}:`, bodyParams);
    return;
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${env.whatsappPhoneNumberId}/messages`;
  const components = [
    ...(bodyParams.length ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }] : []),
    ...(buttonParams?.length
      ? [{ type: 'button', sub_type: 'url', index: '0', parameters: buttonParams.map((text) => ({ type: 'text', text })) }]
      : [])
  ];
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
        components
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
  receivingPhoneNumberId: string | undefined;
}

/** Parses Meta's webhook payload shape down to the parts we care about.
 * Meta gives one Callback URL per app, shared across every verified
 * number on it — this includes which number a message actually arrived
 * on (`metadata.phone_number_id`), so a webhook handler serving multiple
 * numbers for different purposes (here: one for OTP delivery only, one
 * for the AI agent) can tell them apart rather than processing everything
 * the same way regardless of source. */
export function parseInboundMessages(body: any): InboundWhatsAppMessage[] {
  const messages: InboundWhatsAppMessage[] = [];
  const entries = body?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const receivingPhoneNumberId = change?.value?.metadata?.phone_number_id;
      for (const msg of change?.value?.messages ?? []) {
        if (msg.type === 'text' && msg.text?.body) {
          messages.push({ from: msg.from, text: msg.text.body, receivingPhoneNumberId });
        } else if (msg.type === 'location' && msg.location) {
          // Converted into a synthetic text message rather than adding a
          // whole separate message-type path through the agent loop — the
          // system prompt is taught to recognize this exact pattern and
          // call find_nearby_hospitals with the real coordinates, so the
          // existing text-based pipeline handles it with no structural
          // change at all.
          const { latitude, longitude } = msg.location;
          messages.push({
            from: msg.from,
            text: `[LOCATION_SHARED lat=${latitude} lng=${longitude}]`,
            receivingPhoneNumberId
          });
        }
      }
    }
  }
  return messages;
}
