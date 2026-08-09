import { env } from '../config/env.js';
import { uploadBuffer } from './storage.service.js';

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
export async function parseInboundMessages(body: any): Promise<InboundWhatsAppMessage[]> {
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
        } else if (msg.type === 'image' && msg.image) {
          // Same synthetic-text pattern as location sharing above — the
          // actual image bytes get downloaded and stored separately
          // (see downloadAndStoreInboundImage), and the agent sees a
          // plain text marker with the resulting storage key, so the
          // existing text-only conversation loop needs no structural
          // change to handle this.
          const key = await downloadAndStoreInboundImage(msg.image.id, msg.from);
          const caption = msg.image.caption ? ` caption="${msg.image.caption}"` : '';
          messages.push({
            from: msg.from,
            text: key ? `[IMAGE_RECEIVED key=${key}${caption}]` : '[IMAGE_RECEIVED_BUT_DOWNLOAD_FAILED]',
            receivingPhoneNumberId
          });
        }
      }
    }
  }
  return messages;
}

/**
 * Downloads an inbound image from WhatsApp's Media API and re-uploads it
 * to our own storage, returning the storage key (never the raw WhatsApp
 * media URL — that URL is short-lived and requires our access token to
 * fetch, so it's useless to store directly).
 *
 * Two-step process per Meta's API: first resolve the media_id to a real
 * (temporary, auth-required) URL, then fetch the actual bytes from it.
 */
async function downloadAndStoreInboundImage(mediaId: string, fromPhone: string): Promise<string | null> {
  if (!apiConfigured()) {
    console.log(`[whatsapp:dev-mode] would download media ${mediaId}`);
    return null;
  }
  try {
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${env.whatsappAccessToken}` }
    });
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!meta.url) return null;

    const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${env.whatsappAccessToken}` } });
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    const contentType = meta.mime_type ?? 'image/jpeg';
    const extension = contentType.split('/')[1] ?? 'jpg';

    const { key } = await uploadBuffer('vaccination-proofs', `${fromPhone}-${Date.now()}.${extension}`, contentType, buffer);
    return key;
  } catch (err) {
    console.error('Failed to download/store inbound WhatsApp image:', err);
    return null;
  }
}

/**
 * Sends a document (used for the vaccination report PDF). WhatsApp fetches
 * the file itself from the given link rather than requiring us to upload
 * to their media endpoint first — so a short-lived presigned B2 URL works
 * fine here, same pattern as getDownloadUrl elsewhere, just handed to
 * Meta's servers instead of a browser.
 */
export async function sendDocumentMessage(to: string, documentUrl: string, filename: string, caption?: string): Promise<void> {
  if (!apiConfigured()) {
    console.log(`[whatsapp:dev-mode] would send document to ${to}: ${filename}`);
    return;
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${env.whatsappPhoneNumberId}/messages`;
  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.whatsappAccessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { link: documentUrl, filename, ...(caption ? { caption } : {}) }
    })
  });
}

