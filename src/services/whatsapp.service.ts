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

/**
 * Sends a pre-approved template with 1-3 QUICK-REPLY buttons — distinct
 * from sendTemplateMessage's 'url' button support above (a different
 * sub_type in Meta's API). This exists specifically for the doctor
 * instant-consult dispatch: a doctor may never have messaged BEN before,
 * meaning they have no open 24-hour session, and Meta silently refuses
 * to deliver a free-form message (including a free-form interactive
 * button message) outside that window — found via a real case where one
 * doctor never received a dispatch at all with no error anywhere, while
 * another (who'd been actively testing via WhatsApp all day) received it
 * fine. Templates are exempt from the session-window restriction, which
 * is exactly the point of them.
 *
 * buttonPayloads become each button's reply payload, returned later in
 * the webhook as msg.button.payload — normalized into the same
 * buttonReplyId field as free-form interactive replies (see
 * parseInboundMessages), so no downstream routing code needs to know
 * which kind of button produced it.
 */
export async function sendTemplateWithQuickReplyButtons(
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[],
  buttonPayloads: string[]
): Promise<void> {
  if (buttonPayloads.length < 1 || buttonPayloads.length > 3) {
    throw new Error('sendTemplateWithQuickReplyButtons requires 1-3 buttons');
  }
  if (!apiConfigured()) {
    console.log(`[whatsapp:dev-mode] would send template ${templateName} with quick-reply buttons to ${to}:`, bodyParams, buttonPayloads);
    return;
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${env.whatsappPhoneNumberId}/messages`;
  const components = [
    ...(bodyParams.length ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }] : []),
    ...buttonPayloads.map((payload, index) => ({
      type: 'button',
      sub_type: 'quick_reply',
      index: String(index),
      parameters: [{ type: 'payload', payload }]
    }))
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
    throw new Error(`whatsapp_template_quick_reply_send_failed: ${res.status} ${text}`);
  }
}

/**
 * Sends a WhatsApp "reply buttons" interactive message — the mechanism
 * behind the ACCEPT/DECLINE doctor dispatch. Meta caps this at exactly
 * 1–3 buttons and a 20-character title per button, enforced here rather
 * than left to fail at the API, since a silently-truncated button title
 * ("✅ ACCE...") would be confusing to tap.
 */
export async function sendInteractiveButtonsMessage(
  to: string,
  bodyText: string,
  buttons: { id: string; title: string }[]
): Promise<void> {
  if (buttons.length < 1 || buttons.length > 3) {
    throw new Error('sendInteractiveButtonsMessage requires 1-3 buttons');
  }
  for (const b of buttons) {
    if (b.title.length > 20) throw new Error(`button title too long (max 20 chars): ${b.title}`);
  }
  if (!apiConfigured()) {
    console.log(`[whatsapp:dev-mode] would send interactive buttons to ${to}: ${bodyText}`, buttons);
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
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } }))
        }
      }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`whatsapp_interactive_send_failed: ${res.status} ${text}`);
  }
}

/**
 * Sends an image message — used for a doctor's profile photo card. Needs
 * a URL WhatsApp's servers can fetch directly (a short-lived presigned B2
 * URL is fine here, same reasoning as sendDocumentMessage: Meta fetches
 * it once, immediately, at send time — not a repeatedly-cached browser
 * request the way the portal's <img> tag is).
 */
export async function sendImageMessage(to: string, imageUrl: string, caption?: string): Promise<void> {
  if (!apiConfigured()) {
    console.log(`[whatsapp:dev-mode] would send image to ${to}: ${imageUrl}`);
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
      type: 'image',
      image: { link: imageUrl, ...(caption ? { caption } : {}) }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`whatsapp_image_send_failed: ${res.status} ${text}`);
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
  // Present only when this message is a tap on a reply button (e.g. the
  // doctor ACCEPT/DECLINE dispatch) — the id we assigned that button when
  // sending it, e.g. "accept:<requestId>". Routed separately from the
  // patient-facing BEN conversation loop; see whatsapp.routes.ts.
  buttonReplyId?: string;
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
        } else if (msg.type === 'interactive' && msg.interactive?.type === 'button_reply') {
          // A tap on a free-form reply-button message. Kept as its own
          // message type rather than folded into the text pipeline like
          // location/image above — a button tap needs to be routed to
          // the doctor dispatch handler, never to the patient-facing BEN
          // agent loop, and collapsing that distinction here would make
          // that routing decision easy to get wrong later.
          messages.push({
            from: msg.from,
            text: msg.interactive.button_reply.title,
            buttonReplyId: msg.interactive.button_reply.id,
            receivingPhoneNumberId
          });
        } else if (msg.type === 'button' && msg.button) {
          // A tap on a QUICK-REPLY button inside a template message —
          // this is a genuinely different webhook shape than the
          // free-form 'interactive'/'button_reply' case above, not a
          // duplicate of it. Found the hard way: the doctor ACCEPT/
          // DECLINE dispatch had to move to a template (see
          // sendTemplateWithQuickReplyButtons) because a doctor who's
          // never messaged BEN before has no open 24-hour session, and a
          // free-form interactive message silently never arrives outside
          // that window. Template buttons reply with msg.button.payload,
          // not msg.interactive.button_reply.id — normalized into the
          // same buttonReplyId field here so nothing downstream
          // (whatsapp.routes.ts, doctor-whatsapp.service.ts) needs to
          // know or care which kind of button produced it.
          messages.push({
            from: msg.from,
            text: msg.button.text ?? '',
            buttonReplyId: msg.button.payload,
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

