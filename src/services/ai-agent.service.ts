import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { sendTextMessage } from './whatsapp.service.js';
import { createAppointment } from './appointment.service.js';
import { createLabOrder } from './lab-order.service.js';
import { getSlotsForDate, getSlotsForNextDays } from './availability.service.js';
import { requestPayment, checkPaymentStatus } from './payment.service.js';
import { requestLabPayment, checkLabPaymentStatus } from './lab-payment.service.js';
import { generateGlobalPatientId } from './id.service.js';

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

## Starting a new conversation

If there is no prior conversation history (this is the very first message from this patient,
or they've clearly restarted), do these two things, in order, before anything else:

1. Ask which language they prefer — French or English. Wait for their answer before continuing;
   don't guess from the language of their first message. From then on, reply only in whichever
   they chose, until they say otherwise.
2. Then present exactly this menu, translated into whichever language they picked, and wait for
   their choice:
   1. Book a hospital appointment
   2. Book a lab test
   3. Book an online teleconsultation
   4. General inquiry

Once they've picked an option, follow the matching flow below. Don't re-ask the language question
or re-show this menu on later messages in the same conversation unless they explicitly ask to
start over.

## Identify the patient early

Before booking anything (any of options 1-3), use register_or_identify_patient — the phone number
is already known from context, don't ask for it. Do ask for their full name if you don't already
have it. If they're a returning patient this simply confirms who they are with no extra questions;
if they're new, tell them their new MedVAULT ID once so they have it for next time. This has to
happen before create_appointment or create_lab_order, since every booking needs to be linked to a
real patient identity, not left unlinked.

## Option 1 — Hospital appointment (in-person)

1. Use list_hospitals to show real hospitals (filter by city if they mention one).
2. Use create_appointment with appointment_type "in_person" and the chosen hospital_id — no doctor
   or specific time slot is chosen here; the hospital's own front desk handles scheduling once the
   booking reaches them. Don't ask for a preferred date/time for this option; it's not used.

## Option 2 — Lab test

1. Use list_lab_providers to show real labs and their real services (filter by city if mentioned).
2. Use create_lab_order with the real lab_service_ids and prices the previous tool actually
   returned, never invented ones.
3. Offer request_lab_payment once the order exists.

## Option 3 — Online teleconsultation

1. Use list_doctors to show real options (filter by specialty if mentioned).
2. Once a doctor is chosen, use get_doctor_availability to see their REAL open slots. Never
   propose a date/time you haven't actually seen returned by this tool. When mentioning what
   day of the week a date falls on, always use the day_name field the tool gives you — never
   calculate or guess it yourself.
3. Use create_appointment with appointment_type "teleconsult" and the exact doctor_id,
   requested_date, and requested_time the patient picked from those real slots.
4. Once booked, ask if they'd like to pay now via Mobile Money, then use request_appointment_payment.

## Option 4 — General inquiry

Answer directly if it's something you can confidently help with. For anything clinical, a
complaint, or anything you're not confident about, use escalate_to_human instead of guessing.

## Throughout

Keep replies short (2-4 sentences), plain language, in whichever language was chosen at the start
of the conversation — but when calling a tool, always pass names and IDs exactly as a previous
tool gave them to you, never translated or reworded (e.g. don't turn "Doctor" into "Docteur" when
searching — use the literal name you were given). Never invent prices, doctor names, test names,
hospital names, or appointment times — only use what tools actually return to you.`;

const tools: Anthropic.Tool[] = [
  {
    name: 'register_or_identify_patient',
    description:
      "Identify the patient by their WhatsApp number, or register them if this is their first time. Always call this early in a conversation, before booking anything — the phone number itself is already known from context, don't ask for it. Do ask for full name (and date of birth if they're willing to share it). If they already have an account, this returns their existing MedVAULT ID and nothing changes; tell a first-timer their new ID so they know it for next time.",
    input_schema: {
      type: 'object',
      properties: {
        full_name: { type: 'string' },
        dob: { type: 'string', description: 'YYYY-MM-DD, optional' }
      },
      required: ['full_name']
    }
  },
  {
    name: 'list_hospitals',
    description: 'List hospitals a patient can book an in-person appointment at, optionally filtered by city.',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string' } }
    }
  },
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
    description:
      'Book an appointment. For a teleconsult, doctor_id/requested_date/requested_time are required and must exactly match a slot returned by get_doctor_availability — the booking will be rejected otherwise. For an in-person hospital appointment, use hospital_id from list_hospitals instead — no specific doctor or slot is chosen here, the hospital\'s own front desk handles scheduling once the booking reaches them.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_type: { type: 'string', enum: ['teleconsult', 'in_person'] },
        doctor_id: { type: 'string' },
        hospital_id: { type: 'string' },
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
    case 'register_or_identify_patient': {
      const existing = await prisma.globalPatient.findFirst({ where: { primaryPhone: contact.waPhoneNumber } });
      if (existing) {
        if (!contact.globalPatientId) {
          await prisma.whatsAppContact.update({ where: { id: contact.id }, data: { globalPatientId: existing.globalPatientId } });
        }
        return JSON.stringify({ is_new: false, global_patient_id: existing.globalPatientId, full_name: existing.fullName });
      }

      const globalPatientId = await generateGlobalPatientId();
      const created = await prisma.globalPatient.create({
        data: {
          globalPatientId,
          primaryPhone: contact.waPhoneNumber,
          fullName: input.full_name,
          dob: input.dob ? new Date(input.dob) : undefined,
          // A patient who registered themselves via a direct conversation
          // is about as confident an identity match as this system has —
          // matches the same 75 used for hospital-side self-reported
          // registration in sync.routes.ts, not the lower confidence
          // fuzzy-matched identities get.
          identityConfidence: 75
        }
      });
      await prisma.whatsAppContact.update({ where: { id: contact.id }, data: { globalPatientId } });
      return JSON.stringify({ is_new: true, global_patient_id: created.globalPatientId, full_name: created.fullName });
    }

    case 'list_hospitals': {
      const hospitals = await prisma.hospital.findMany({
        where: { status: 'active', ...(input.city ? { city: { contains: input.city, mode: 'insensitive' } } : {}) },
        take: 15
      });
      return JSON.stringify(
        hospitals.map((h: any) => ({ hospital_id: h.hospitalId, name: h.name, city: h.city, region: h.region }))
      );
    }

    case 'list_doctors': {
      // A plain substring match on the whole name is too fragile here —
      // found in testing: asked in French, the model naturally said
      // "Docteur B3" instead of the literal stored name "Test Doctor B3"
      // (translating "Doctor" and dropping "Test"), and an exact-phrase
      // match correctly failed to find a doctor who actually exists.
      // Match on distinctive individual words instead, ignoring common
      // title words in either language, so a paraphrased name still finds
      // the right person.
      const commonWords = new Set(['doctor', 'docteur', 'dr', 'test', 'the', 'le', 'la', 'un', 'une', 'a', 'an']);
      const nameWords = (input.name ?? '')
        .split(/\s+/)
        .map((w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
        .filter((w: string) => w.length >= 2 && !commonWords.has(w));

      const doctors = await prisma.doctor.findMany({
        where: {
          verificationStatus: 'verified',
          ...(input.specialty ? { specialty: { contains: input.specialty, mode: 'insensitive' } } : {}),
          ...(nameWords.length > 0
            ? { OR: nameWords.map((w: string) => ({ fullName: { contains: w, mode: 'insensitive' } })) }
            : {})
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
      if (input.appointment_type === 'in_person' && !input.hospital_id) {
        return JSON.stringify({ error: 'hospital_id_required_for_in_person', message: 'Call list_hospitals first and use a real hospital_id.' });
      }
      const appt = await createAppointment({
        globalPatientId: contact.globalPatientId ?? undefined,
        doctorId: input.doctor_id,
        hospitalId: input.hospital_id,
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

  let contact = await prisma.whatsAppContact.upsert({
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

      // A tool later in this same turn (e.g. create_appointment right
      // after registering) needs the fresh ID, not the stale one this
      // turn started with — re-read the contact rather than trust
      // whatever local state might exist, since the tool itself is the
      // one place that actually wrote it to the database.
      if (toolUse.name === 'register_or_identify_patient') {
        const refreshed = await prisma.whatsAppContact.findUnique({ where: { id: contact.id } });
        if (refreshed) contact = refreshed;
      }
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
