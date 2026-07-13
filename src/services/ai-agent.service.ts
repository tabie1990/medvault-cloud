import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { sendTextMessage } from './whatsapp.service.js';
import { createAppointment } from './appointment.service.js';
import { createLabOrder, getLabOrder } from './lab-order.service.js';

const MODEL = 'claude-haiku-4-5-20251001'; // cheapest capable model — fits a bounded conversational task
const MAX_TOOL_ITERATIONS = 4;
const MAX_STORED_TURNS = 8;

const SYSTEM_PROMPT = `You are the MedVAULT WhatsApp assistant for a healthcare network in Cameroon.
You can: book a teleconsult appointment, browse labs and book a lab test (home visit or on-site),
and check the status of an existing lab order. Keep replies short (2-4 sentences), plain language,
and in the language the patient writes in (English or French). If a request needs a human
(clinical questions, complaints, anything you're not confident about), use escalate_to_human
instead of guessing. Never invent prices, test names, or appointment times — only use what tools
return to you.`;

const tools: Anthropic.Tool[] = [
  {
    name: 'create_appointment',
    description: 'Book a teleconsult or in-person appointment for this patient.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_type: { type: 'string', enum: ['teleconsult', 'in_person'] },
        requested_date: { type: 'string', description: 'YYYY-MM-DD' },
        requested_time: { type: 'string', description: 'HH:MM, 24h' },
        notes: { type: 'string' }
      },
      required: ['appointment_type']
    }
  },
  {
    name: 'list_lab_providers',
    description: 'List available labs, optionally filtered by city, with their offered service type.',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string' } }
    }
  },
  {
    name: 'create_lab_order',
    description: 'Book a lab test with a specific lab provider.',
    input_schema: {
      type: 'object',
      properties: {
        lab_provider_id: { type: 'string' },
        lab_service_ids: { type: 'array', items: { type: 'string' } },
        service_type: { type: 'string', enum: ['home_visit', 'on_site', 'both'] },
        home_address: { type: 'string' },
        scheduled_date: { type: 'string' },
        scheduled_time: { type: 'string' }
      },
      required: ['lab_provider_id', 'lab_service_ids', 'service_type']
    }
  },
  {
    name: 'check_lab_order_status',
    description: 'Check the status/result of an existing lab order by its order reference.',
    input_schema: {
      type: 'object',
      properties: { order_ref: { type: 'string' } },
      required: ['order_ref']
    }
  },
  {
    name: 'escalate_to_human',
    description: 'Hand off to a human staff member instead of answering directly.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason']
    }
  }
];

async function executeTool(
  name: string,
  input: any,
  contact: { id: string; globalPatientId: string | null; waPhoneNumber: string }
): Promise<string> {
  switch (name) {
    case 'create_appointment': {
      const appt = await createAppointment({
        globalPatientId: contact.globalPatientId ?? undefined,
        appointmentType: input.appointment_type,
        requestedDate: input.requested_date,
        requestedTime: input.requested_time,
        notes: input.notes,
        source: 'whatsapp_ai',
        channel: 'whatsapp'
      });
      return JSON.stringify({ appointment_ref: appt.appointmentRef, status: appt.status });
    }
    case 'list_lab_providers': {
      const providers = await prisma.labProvider.findMany({
        where: input.city ? { city: input.city, verificationStatus: 'verified' } : { verificationStatus: 'verified' },
        include: { services: { where: { isActive: true } } },
        take: 10
      });
      return JSON.stringify(
        providers.map((p: any) => ({
          id: p.id,
          name: p.name,
          city: p.city,
          service_type: p.serviceType,
          tests: p.services.map((s: any) => ({ id: s.id, name: s.testName, price: s.basePrice }))
        }))
      );
    }
    case 'create_lab_order': {
      const order = await createLabOrder({
        globalPatientId: contact.globalPatientId ?? undefined,
        labProviderId: input.lab_provider_id,
        labServiceIds: input.lab_service_ids,
        serviceType: input.service_type,
        homeAddress: input.home_address,
        scheduledDate: input.scheduled_date,
        scheduledTime: input.scheduled_time,
        source: 'whatsapp_ai'
      });
      return JSON.stringify({ order_ref: order?.orderRef, total_cost: order?.totalCost, status: order?.status });
    }
    case 'check_lab_order_status': {
      const order = await prisma.labOrder.findUnique({ where: { orderRef: input.order_ref } });
      if (!order) return JSON.stringify({ found: false });
      return JSON.stringify({ found: true, status: order.status, result_ready: order.status === 'completed' });
    }
    case 'escalate_to_human': {
      return JSON.stringify({ escalated: true });
    }
    default:
      return JSON.stringify({ error: 'unknown_tool' });
  }
}

/**
 * Entry point for the WhatsApp webhook route. Runs a bounded tool-use loop
 * against Claude, executing tool calls against the same internal service
 * functions the HTTP routes use — the agent never gets its own write path
 * into the database.
 */
export async function handleIncomingWhatsAppMessage(phone: string, text: string): Promise<void> {
  if (!env.anthropicApiKey) {
    console.log(`[ai-agent:dev-mode] no ANTHROPIC_API_KEY set — echoing message from ${phone}: ${text}`);
    await sendTextMessage(phone, "Thanks for your message — our assistant isn't configured yet. A staff member will follow up.");
    return;
  }

  const contact = await prisma.whatsAppContact.upsert({
    where: { waPhoneNumber: phone },
    update: { lastInteractionAt: new Date() },
    create: { waPhoneNumber: phone }
  });

  const priorTurns = Array.isArray((contact.conversationState as any)?.turns)
    ? ((contact.conversationState as any).turns as Anthropic.MessageParam[])
    : [];

  const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });
  const messages: Anthropic.MessageParam[] = [...priorTurns, { role: 'user', content: text }];

  let finalText = '';
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      tools,
      messages
    });

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

    if (toolUses.length === 0) {
      finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      messages.push({ role: 'assistant', content: response.content });
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const result = await executeTool(toolUse.name, toolUse.input, {
        id: contact.id,
        globalPatientId: contact.globalPatientId,
        waPhoneNumber: contact.waPhoneNumber
      });
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  if (!finalText) {
    finalText = "Sorry, I couldn't complete that — a staff member will follow up shortly.";
  }

  await sendTextMessage(phone, finalText);

  await prisma.whatsAppContact.update({
    where: { id: contact.id },
    data: { conversationState: { turns: messages.slice(-MAX_STORED_TURNS) } as any }
  });
}
