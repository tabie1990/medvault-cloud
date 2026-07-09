import { Router } from 'express';
import { verifyWebhookChallenge, parseInboundMessages } from '../services/whatsapp.service.js';
import { handleIncomingWhatsAppMessage } from '../services/ai-agent.service.js';
import { asyncHandler } from '../middleware/error.middleware.js';

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
    const messages = parseInboundMessages(req.body);
    for (const msg of messages) {
      handleIncomingWhatsAppMessage(msg.from, msg.text).catch((err) =>
        console.error('ai-agent error:', err)
      );
    }
  })
);
