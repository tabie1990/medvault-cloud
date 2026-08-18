import { Router } from 'express';
import { verifyWebhookChallenge, parseInboundMessages } from '../services/whatsapp.service.js';
import { handleIncomingWhatsAppMessage } from '../services/ai-agent.service.js';
import { handleDoctorWhatsAppInteraction } from '../services/doctor-whatsapp.service.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { env } from '../config/env.js';

export const whatsappRouter = Router();

// Meta's one-time webhook verification handshake.
whatsappRouter.get('/webhook', (req, res) => {
  const challenge = verifyWebhookChallenge(req.query as Record<string, unknown>);
  if (challenge) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// Inbound messages. Must ack quickly — Meta expects a fast 200 — so we
// acknowledge immediately and let the AI agent run after responding.
whatsappRouter.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    res.sendStatus(200);
    const messages = await parseInboundMessages(req.body);
    for (const msg of messages) {
      // This one Callback URL is shared across every number on the Meta
      // app — including a separate number used only for OTP delivery to
      // a different system entirely. Only react to messages that actually
      // arrived on the AI agent's own number; anything else is silently
      // ignored rather than accidentally treated as a conversation.
      if (msg.receivingPhoneNumberId && msg.receivingPhoneNumberId !== env.whatsappPhoneNumberId) {
        continue;
      }
      // Button taps (currently: only the doctor ACCEPT/DECLINE dispatch)
      // are routed to the doctor handler, never into the patient-facing
      // BEN conversation loop — same phone number, same webhook, but a
      // structurally different kind of message. This is also why it's
      // checked first: a doctor is never expected to be mid-conversation
      // with BEN at the same time as replying to a dispatch, so there's
      // no ambiguity to resolve between the two paths.
      if (msg.buttonReplyId) {
        handleDoctorWhatsAppInteraction(msg.from, msg.buttonReplyId).catch((err) =>
          console.error('doctor-whatsapp error:', err)
        );
        continue;
      }
      handleIncomingWhatsAppMessage(msg.from, msg.text).catch((err) =>
        console.error('ai-agent error:', err)
      );
    }
  })
);
