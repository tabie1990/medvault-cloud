import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { sendTextMessage } from './whatsapp.service.js';
import { createAppointment } from './appointment.service.js';
import { createLabOrder } from './lab-order.service.js';
import { getSlotsForDate, getSlotsForNextDays } from './availability.service.js';
import { requestPayment, checkPaymentStatus } from './payment.service.js';
import { requestLabPayment, checkLabPaymentStatus } from './lab-payment.service.js';

const MODEL = 'claude-haiku-4-5-20251001'; // cheapest capable model — fits a bounded conversational task
const MAX_TOOL_ITERATIONS = 4;
const MAX_STORED_TURNS = 8;

/**
 * Truncates conversation history to the last N genuine exchanges, never
 * mid-way through a tool_use/tool_result pair. A naive `messages.slice(-N)`
 * on the raw array is unsafe here: a single logical exchange in a
 * tool-using conversation isn't one array entry, it's several (user
 * message → assistant message with a tool call → user message with that
 * tool's result → ...), and cutting inside that sequence leaves a
 * dangling tool_result with no matching tool_use before it — which
 * Anthropic's API correctly rejects on the next call. Found this exact
 * failure in testing, not theoretically: a real conversation broke after
 * enough tool calls accumulated. Fix: only ever start the retained window
 * at a genuine new user text message, since everything between one of
 * those and the next forms a complete, self-contained exchange.
 */
function truncateConversation(messages: Anthropic.MessageParam[], maxExchanges: number): Anthropic.MessageParam[] {
  const userTextIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user' && typeof messages[i].content === 'string') {
      userTextIndices.push(i);
    }
  }
  if (userTextIndices.length <= maxExchanges) return messages;
  const cutIndex = userTextIndices[userTextIndices.length - maxExchanges];
  return messages.slice(cutIndex);
}

const SYSTEM_PROMPT = `You are the MedVAULT WhatsApp assistant for a healthcare network in Cameroon.

You can: help a patient find and book a teleconsult with a specific doctor, take payment for it,
browse labs and book a lab test (home visit or on-site), take payment for that, and check the
status of an existing appointment or lab order.

For a teleconsult booking, always follow this order — never skip a step or guess:
1. Use list_doctors to show real options (filter by specialty if the patient mentions one).
2. Once a doctor is chosen, use get_doctor_availability to see their REAL open slots. Never
   propose a date/time you haven't actually seen returned by this tool. When mentioning what
   day of the week a date falls on, always use the day_name field the tool gives you — never
   calculate or guess it yourself.
3. Use create_appointment with the exact doctor_id, requested_date, and requested_time the
   patient picked from those real slots.
4. Once booked, ask if they'd like to pay now via Mobile Money, then use request_appointment_payment.

Same idea for a lab test: list_lab_providers first, then create_lab_order with real service IDs
and prices from what that tool returned, then offer request_lab_payment.

Keep replies short (2-4 sentences), plain language, and in the language the patient writes in
(English or French). If a request needs a human (clinical questions, complaints, anything you're
not confident about), use escalate_to_human instead of guessing. Never invent prices, doctor
names, test names, or appointment times — only use what tools return to you.`;

const tools: Anthropic.Tool[] = [
  {
    name: 'list_doctors',
    description: 'List verified doctors available for teleconsult. Filter by specialty, or by name if the patient asks for a specific doctor by name — use name, not specialty, when they mention a doctor\'s name.',
    input_schema: {
      type: 'object',
      properties: {
        specialty: { type: 'string' },
        name: { type: 'string', description: "The doctor's name or part of it, if the patient asked for someone specific" }
      }
    }
  },
  {
    name: 'get_doctor_availability',
    description: "Get a specific doctor's real open teleconsult slots for the next several days. Always call this before proposing a time.",
    input_schema: {
      type: 'object',
      properties: {
        doctor_id: { type: 'string' },
        days: { type: 'number', description: 'How many days ahead to check, default 7, max 14' }
      },
      required: ['doctor_id']
    }
  },
  {
    name: 'create_appointment',
    description: 'Book a teleconsult appointment. For teleconsult, doctor_id/requested_date/requested_time are required and must exactly match a slot returned by get_doctor_availability — the booking will be rejected otherwise.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_type: { type: 'string', enum: ['teleconsult', 'in_person'] },
        doctor_id: { type: 'string' },
        requested_date: { type: 'string', description: 'YYYY-MM-DD' },
        requested_time: { type: 'string', description: 'HH:MM, 24h' },
        notes: { type: 'string' }
      },
      required: ['appointment_type']
    }
  },
  {
    name: 'check_appointment_status',
    description: 'Check the status and payment status of an existing appointment by its reference.',
    input_schema: {
      type: 'object',
      properties: { appointment_ref: { type: 'string' } },
      required: ['appointment_ref']
    }
  },
  {
    name: 'request_appointment_payment',
    description: "Request Mobile Money payment for a booked appointment — triggers a USSD prompt on the patient's phone.",
    input_schema: {
      type: 'object',
      properties: {
        appointment_ref: { type: 'string' },
        phone: { type: 'string', description: 'Cameroon MoMo number, format 237XXXXXXXXX' },
        amount: { type: 'number' }
      },
      required: ['appointment_ref', 'phone', 'amount']
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
    description: 'Check the status, payment status, and result readiness of an existing lab order by its reference.',
    input_schema: {
      type: 'object',
      properties: { order_ref: { type: 'string' } },
      required: ['order_ref']
    }
  },
  {
    name: 'request_lab_payment',
    description: "Request Mobile Money payment for a lab order — triggers a USSD prompt on the patient's phone.",
    input_schema: {
      type: 'object',
      properties: {
        order_ref: { type: 'string' },
        phone: { type: 'string', description: 'Cameroon MoMo number, format 237XXXXXXXXX' },
        amount: { type: 'number' }
      },
      required: ['order_ref', 'phone', 'amount']
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
    case 'list_doctors': {
      const doctors = await prisma.doctor.findMany({
        where: {
          verificationStatus: 'verified',
          ...(input.specialty ? { specialty: { contains: input.specialty, mode: 'insensitive' } } : {}),
          ...(input.name ? { fullName: { contains: input.name, mode: 'insensitive' } } : {})
        },
        take: 10
      });
      return JSON.stringify(
        doctors.map((d: any) => ({
          id: d.id,
          name: d.fullName,
          specialty: d.specialty,
          consultation_types: d.consultationTypes,
          teleconsult_fee: d.teleconsultFee
        }))
      );
    }

    case 'get_doctor_availability': {
      const days = Math.min(Number(input.days ?? 7), 14);
      try {
        const slots = await getSlotsForNextDays(input.doctor_id, days);
        // Attach the real day name to each date directly, rather than
        // leaving the model to compute "what day of week is this date"
        // itself — caught this exact failure in testing: a correct date
        // (Tuesday) got mislabeled "Wednesday" in the model's reply, even
        // though the underlying tool data was right. Removes the need for
        // the model to do date arithmetic at all; it can only repeat what
        // it's given here.
        const withDayNames = Object.fromEntries(
          Object.entries(slots).map(([dateStr, times]) => [
            dateStr,
            { day_name: new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }), times }
          ])
        );
        return JSON.stringify({ found: true, availability: withDayNames });
      } catch {
        return JSON.stringify({ found: false });
      }
    }

    case 'create_appointment': {
      if (input.appointment_type === 'teleconsult') {
        if (!input.doctor_id || !input.requested_date || !input.requested_time) {
          return JSON.stringify({
            error: 'doctor_id, requested_date, and requested_time are all required for a teleconsult'
          });
        }
        // The actual gate this whole upgrade exists for — never let the
        // model book a time it merely guessed sounds plausible.
        const realSlots = await getSlotsForDate(input.doctor_id, input.requested_date);
        if (!realSlots.includes(input.requested_time)) {
          return JSON.stringify({
            error: 'requested_time_not_available',
            message: 'That slot is not actually open. Call get_doctor_availability again and offer a real one.'
          });
        }
      }
      const appt = await createAppointment({
        globalPatientId: contact.globalPatientId ?? undefined,
        doctorId: input.doctor_id,
        appointmentType: input.appointment_type,
        requestedDate: input.requested_date,
        requestedTime: input.requested_time,
        notes: input.notes,
        source: 'whatsapp_ai',
        channel: 'whatsapp'
      });
      return JSON.stringify({ appointment_ref: appt.appointmentRef, status: appt.status });
    }

    case 'check_appointment_status': {
      const appt = await prisma.appointment.findUnique({ where: { appointmentRef: input.appointment_ref } });
      if (!appt) return JSON.stringify({ found: false });
      return JSON.stringify({ found: true, status: appt.status, payment_status: appt.paymentStatus });
    }

    case 'request_appointment_payment': {
      const appt = await prisma.appointment.findUnique({ where: { appointmentRef: input.appointment_ref } });
      if (!appt) return JSON.stringify({ error: 'appointment_not_found' });
      try {
        const data = await requestPayment(appt.id, input.phone, Number(input.amount));
        return JSON.stringify({ success: true, ...data });
      } catch (e: any) {
        return JSON.stringify({ error: e.message });
      }
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
      return JSON.stringify({
        found: true,
        status: order.status,
        payment_status: order.paymentStatus,
        result_ready: order.status === 'completed'
      });
    }

    case 'request_lab_payment': {
      const order = await prisma.labOrder.findUnique({ where: { orderRef: input.order_ref } });
      if (!order) return JSON.stringify({ error: 'lab_order_not_found' });
      try {
        const data = await requestLabPayment(order.id, input.phone, Number(input.amount));
        return JSON.stringify({ success: true, ...data });
      } catch (e: any) {
        return JSON.stringify({ error: e.message });
      }
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
      console.log(`[ai-agent:tool] ${toolUse.name}(${JSON.stringify(toolUse.input)}) -> ${result}`);
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
    data: { conversationState: { turns: truncateConversation(messages, MAX_STORED_TURNS) } as any }
  });
}
