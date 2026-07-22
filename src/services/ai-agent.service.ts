import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { sendTextMessage } from './whatsapp.service.js';
import { createAppointment } from './appointment.service.js';
import { createLabOrder } from './lab-order.service.js';
import { getSlotsForDate, getSlotsForNextDays } from './availability.service.js';
import {
  getSlotsForDate as getHospitalRosterSlotsForDate,
  getSlotsForNextDays as getHospitalRosterSlotsForNextDays
} from './hospital-roster-availability.service.js';
import { requestPayment, checkPaymentStatus } from './payment.service.js';
import { requestLabPayment, checkLabPaymentStatus } from './lab-payment.service.js';
import { generateGlobalPatientId } from './id.service.js';
import { findHospitalsNear } from './hospital-search.service.js';
import { logError } from './error-log.service.js';

const MODEL = 'claude-haiku-4-5-20251001'; // cheapest capable model — fits a bounded conversational task
const MAX_TOOL_ITERATIONS = 4;
const MAX_STORED_TURNS = 8;

// Same reasoning as the day-name fix elsewhere in this file — a tool
// result should always supply the day name directly, never leave the
// model to compute one itself from a raw index.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Resolved relative to this compiled file's own location (dist/services/),
// not the process's working directory — robust regardless of how/where
// PM2 was actually invoked from. Two levels up from dist/services/ reaches
// the project root, where prompts/ sits as a sibling to both src/ and
// dist/, deliberately outside the TypeScript build so editing it never
// needs a rebuild — just this file changed and `pm2 restart`.
const SYSTEM_PROMPT = readFileSync(join(__dirname, '../../prompts/whatsapp-agent-system-prompt.md'), 'utf-8');

const tools: Anthropic.Tool[] = [
  {
    name: 'register_or_identify_patient',
    description:
      "Identify the patient by their WhatsApp number, or register them if this is their first time. Always call this early in a conversation, before booking anything — the phone number itself is already known from context, don't ask for it. Ask for full name AND date of birth together in one message before calling this — both are required to correctly identify or register the patient. If they already have an account, this returns their existing MedVAULT ID and nothing changes; tell a first-timer their new ID so they know it for next time.",
    input_schema: {
      type: 'object',
      properties: {
        full_name: { type: 'string' },
        dob: { type: 'string', description: 'YYYY-MM-DD' }
      },
      required: ['full_name', 'dob']
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
    name: 'get_hospital_doctors',
    description: "Get a specific hospital's roster of doctors and their working hours, so the patient knows who they might see and roughly when before booking an in-person appointment there.",
    input_schema: {
      type: 'object',
      properties: { hospital_id: { type: 'string' } },
      required: ['hospital_id']
    }
  },
  {
    name: 'get_hospital_doctor_slots',
    description: "Get a specific hospital-roster doctor's real open appointment slots for the next several days, using hospital_doctor_roster_id from get_hospital_doctors. Always call this before proposing a time, same as teleconsult availability.",
    input_schema: {
      type: 'object',
      properties: {
        hospital_doctor_roster_id: { type: 'string' },
        days: { type: 'number', description: 'How many days ahead to check, default 7, max 14' }
      },
      required: ['hospital_doctor_roster_id']
    }
  },
  {
    name: 'find_nearby_hospitals',
    description: 'Find real hospitals near a specific GPS location, sorted by distance. Use this when the patient has shared their location (a message in the form [LOCATION_SHARED lat=... lng=...]) — pass those exact coordinates through, never estimate or guess coordinates yourself.',
    input_schema: {
      type: 'object',
      properties: {
        latitude: { type: 'number' },
        longitude: { type: 'number' }
      },
      required: ['latitude', 'longitude']
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
      "Book an appointment. For a teleconsult, doctor_id/requested_date/requested_time are required and must exactly match a slot returned by get_doctor_availability — the booking will be rejected otherwise. For an in-person hospital appointment: if the patient picked a specific roster doctor, pass hospital_id, hospital_doctor_roster_id, requested_date, and requested_time together, matching a real slot from get_hospital_doctor_slots exactly — rejected otherwise, same discipline as teleconsult. If no specific doctor was chosen, hospital_id alone is enough and the hospital's own front desk handles scheduling.",
    input_schema: {
      type: 'object',
      properties: {
        appointment_type: { type: 'string', enum: ['teleconsult', 'in_person'] },
        doctor_id: { type: 'string' },
        hospital_id: { type: 'string' },
        hospital_doctor_roster_id: { type: 'string' },
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
        hospitals.map((h: any) => ({
          hospital_id: h.hospitalId,
          name: h.name,
          city: h.city,
          region: h.region,
          flat_booking_fee: h.flatBookingFee ? Number(h.flatBookingFee) : null
        }))
      );
    }

    case 'get_hospital_doctors': {
      const roster = await prisma.hospitalDoctorRoster.findMany({
        where: { hospitalId: input.hospital_id },
        include: { workingHours: true }
      });
      if (roster.length === 0) return JSON.stringify({ found: true, doctors: [] });
      return JSON.stringify({
        found: true,
        doctors: roster.map((d: any) => ({
          hospital_doctor_roster_id: d.id,
          name: d.fullName,
          specialty: d.specialty,
          working_hours: d.workingHours.map((w: any) => ({
            day_name: DAY_NAMES[w.dayOfWeek],
            start_time: w.startTime,
            end_time: w.endTime
          }))
        }))
      });
    }

    case 'get_hospital_doctor_slots': {
      const days = Math.min(Number(input.days ?? 7), 14);
      try {
        const slots = await getHospitalRosterSlotsForNextDays(input.hospital_doctor_roster_id, days);
        // Same reasoning as get_doctor_availability — attach the real day
        // name directly rather than leaving the model to compute it.
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

    case 'find_nearby_hospitals': {
      const nearby = await findHospitalsNear(Number(input.latitude), Number(input.longitude), 25);
      return JSON.stringify({
        found: true,
        hospitals: nearby.map((h: any) => ({
          hospital_id: h.hospitalId,
          name: h.name,
          city: h.city,
          distance_km: Math.round(h.distance_km * 10) / 10
        }))
      });
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
          teleconsult_fee: d.teleconsultFee ? Number(d.teleconsultFee) : null
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
      if (input.appointment_type === 'in_person' && input.hospital_doctor_roster_id) {
        if (!input.requested_date || !input.requested_time) {
          return JSON.stringify({
            error: 'requested_date_and_requested_time_required_when_a_roster_doctor_is_chosen'
          });
        }
        // Same gate as teleconsult — never let the model book a time it
        // merely guessed sounds plausible.
        const realSlots = await getHospitalRosterSlotsForDate(input.hospital_doctor_roster_id, input.requested_date);
        if (!realSlots.includes(input.requested_time)) {
          return JSON.stringify({
            error: 'requested_time_not_available',
            message: 'That slot is not actually open. Call get_hospital_doctor_slots again and offer a real one.'
          });
        }
      }
      const appt = await createAppointment({
        globalPatientId: contact.globalPatientId ?? undefined,
        doctorId: input.doctor_id,
        hospitalId: input.hospital_id,
        hospitalDoctorRosterId: input.hospital_doctor_roster_id,
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
      // A stale 'pending' read from the database was the actual bug here —
      // nothing else in the system re-checks Campay unless this does, so a
      // patient asking "did it go through" got told "pending" forever even
      // after Campay itself had long since confirmed success.
      if (appt.paymentStatus === 'pending' && appt.paymentReference) {
        const fresh = await checkPaymentStatus(appt.id);
        return JSON.stringify({ found: true, status: appt.status, payment_status: fresh.status });
      }
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
          tests: p.services.map((s: any) => ({ id: s.id, name: s.testName, price: Number(s.basePrice) }))
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
      return JSON.stringify({ order_ref: order?.orderRef, total_cost: order?.totalCost ? Number(order.totalCost) : null, status: order?.status });
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
      // Previously did nothing at all beyond telling the model it had
      // "handed off" — no admin ever actually saw this. Reuses the same
      // ErrorLog + resolve mechanism as background errors, since both
      // are "something a human needs to see and mark done" — not a
      // separate model/UI just for this.
      await logError(`escalation:whatsapp:${contact.waPhoneNumber}`, new Error(input.reason ?? 'No reason given'));
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
