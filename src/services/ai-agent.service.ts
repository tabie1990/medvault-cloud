import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { sendTextMessage, sendDocumentMessage, sendImageMessage } from './whatsapp.service.js';
import { generateVaccinationReportPdf } from './pediatric-report.service.js';
import { createAppointment } from './appointment.service.js';
import { createInstantRequest } from './teleconsult-request.service.js';
import { createLabOrder } from './lab-order.service.js';
import { getSlotsForDate, getSlotsForNextDays } from './availability.service.js';
import {
  getSlotsForDate as getHospitalRosterSlotsForDate,
  getSlotsForNextDays as getHospitalRosterSlotsForNextDays
} from './hospital-roster-availability.service.js';
import { requestPayment, checkPaymentStatus } from './payment.service.js';
import { requestLabPayment, checkLabPaymentStatus } from './lab-payment.service.js';
import { generateGlobalPatientId, generateReferralCode } from './id.service.js';
import { createPendingVaccinationRecords } from './pediatric.service.js';
import { findHospitalsNear } from './hospital-search.service.js';
import { logError } from './error-log.service.js';

const MODEL = 'claude-haiku-4-5-20251001'; // cheapest capable Anthropic model — fits a bounded conversational task
const OPENAI_MODEL = 'gpt-4o-mini'; // chosen specifically for cost comparison against Haiku, still handles tool-calling well
const MAX_TOOL_ITERATIONS = 4;

// The language prompt and welcome menu are fixed, non-personalized text
// with zero need for the model to generate them at all — sent directly
// from handleIncomingWhatsAppMessage's fresh-conversation branch below,
// never through the model. Found via repeated real testing where the
// model reconstructed the menu "from gist" differently on nearly every
// attempt (a missing item, a reworded item, an invented item that
// doesn't exist) despite explicit "copy this exactly" instructions — a
// known LLM verbatim-reproduction limit, not something more prompt
// wording fixes. Keep these two strings in sync with Section 4 of
// prompts/whatsapp-agent-system-prompt.md by hand; there's no single
// source of truth linking the two files.
const LANGUAGE_PROMPT = `🌍 Which language would you like to use?\n1️⃣ 🇬🇧 English\n2️⃣ 🇫🇷 Français`;

const WELCOME_MENU: Record<'en' | 'fr', string> = {
  en: `👋 Welcome to MedVAULT. How can I help you today?\n1️⃣ 🏥 Book a hospital appointment\n2️⃣ 🧪 Book a laboratory test\n3️⃣ 💻 Book an online teleconsultation\n4️⃣ 👶 Child vaccination tracking\n5️⃣ ❓ General inquiry`,
  fr: `👋 Bienvenue sur MedVAULT. Comment puis-je vous aider aujourd'hui ?\n1️⃣ 🏥 Prendre un rendez-vous à l'hôpital\n2️⃣ 🧪 Réserver un examen de laboratoire\n3️⃣ 💻 Réserver une téléconsultation\n4️⃣ 👶 Suivi de vaccination de l'enfant\n5️⃣ ❓ Demande générale`
};

function detectLanguageChoice(text: string): 'en' | 'fr' | null {
  const t = text.trim().toLowerCase();
  if (['1', 'english', 'anglais', 'en'].includes(t) || t.includes('🇬🇧')) return 'en';
  if (['2', 'french', 'français', 'francais', 'fr'].includes(t) || t.includes('🇫🇷')) return 'fr';
  return null;
}

// Explicit restart requests — found via real testing showing this is
// actually the MOST common way the menu gets tested/re-triggered, not
// an edge case: "start over," "reset," "recommencer," etc. Checked
// before anything else so a restart gets the exact same guaranteed-
// correct hardcoded menu a brand-new contact does, rather than falling
// through to the model to regenerate from scratch (and reproduce the
// same verbatim-text unreliability all over again).
const RESTART_PATTERN = /\b(start\s*(all\s*)?over|restart|reset|start\s*again|recommenc|reinitial|réinitial)/i;

/**
 * Looks up whether this patient currently has an instant-consult
 * appointment a doctor has already accepted but that isn't paid yet, and
 * returns a short factual note to append to the system prompt for this
 * one request if so — or null if not. Run fresh from the database on
 * every single incoming message, never cached or remembered from
 * conversation history. This exists because the model's own memory of
 * "has a doctor accepted" repeatedly proved unreliable in real testing —
 * it would confidently tell the patient to keep waiting well after
 * acceptance, since that event happens entirely outside its own
 * conversation loop (see doctor-whatsapp.service.ts). Rather than hoping
 * the model remembers to call get_my_recent_appointments on its own,
 * this hands it the current, verified fact directly, every turn,
 * whether it asks for it or not.
 */
async function findPendingUnpaidInstantConsult(globalPatientId: string | null) {
  if (!globalPatientId) return null;
  return prisma.appointment.findFirst({
    where: {
      globalPatientId,
      channel: 'ben_instant_consult',
      paymentStatus: { not: 'paid' },
      createdAt: { gt: new Date(Date.now() - 30 * 60 * 1000) }
    },
    orderBy: { createdAt: 'desc' },
    include: { doctor: { select: { fullName: true, teleconsultFee: true } } }
  });
}

async function buildPendingInstantConsultNote(globalPatientId: string | null): Promise<string | null> {
  if (!globalPatientId) {
    console.log('[pending-consult-note] no globalPatientId on contact — skipping');
    return null;
  }
  const appt = await findPendingUnpaidInstantConsult(globalPatientId);
  if (!appt) {
    console.log(`[pending-consult-note] no matching unpaid instant-consult appointment for globalPatientId=${globalPatientId}`);
    return null;
  }
  console.log(`[pending-consult-note] FOUND appointmentRef=${appt.appointmentRef} paymentStatus=${appt.paymentStatus} channel=${appt.channel} createdAt=${appt.createdAt.toISOString()}`);
  return (
    `CURRENT VERIFIED FACT (from the database, not your memory — this is always current): ` +
    `this patient has an instant teleconsult appointment (ref ${appt.appointmentRef}) that Dr. ${appt.doctor?.fullName ?? 'the doctor'} has ALREADY ACCEPTED. ` +
    `It is not yet paid (fee: ${appt.doctor?.teleconsultFee ? Number(appt.doctor.teleconsultFee) : 'unknown'} XAF). ` +
    `Do NOT tell the patient a doctor hasn't accepted yet or that you're still waiting — that would be wrong. ` +
    `If the patient's next message could be a Mobile Money number or a question about status or payment, treat it as such immediately and call request_appointment_payment with appointment_ref "${appt.appointmentRef}" — do not ask them to confirm the number first.`
  );
}

/**
 * A message that's essentially just a phone number and nothing else —
 * the shape of a Mobile Money reply, not a menu choice ("1", "2") or
 * general conversation. Deliberately requires 8+ digits so short menu
 * selections never match.
 */
function looksLikeBarePhoneNumber(text: string): boolean {
  const stripped = text.trim().replace(/[\s\-()]/g, '');
  return /^\+?\d{8,13}$/.test(stripped);
}

/**
 * Charges the fee on file for an appointment and sends the confirmation
 * directly — the actual charging + messaging logic behind the
 * request_appointment_payment tool, pulled out so it can ALSO be called
 * directly from handleIncomingWhatsAppMessage's deterministic
 * bare-phone-number intercept below, bypassing the model entirely for
 * that one case. Extracted after real testing showed the model ignoring
 * even an explicit, verified "a doctor already accepted" fact injected
 * directly into its own system prompt for that exact request — at that
 * point, no amount of instruction placement was going to fix it
 * reliably, and this specific scenario (bare phone number + a known
 * pending unpaid instant-consult appointment) is narrow and unambiguous
 * enough to just handle deterministically instead, the same way the
 * welcome menu is.
 */
async function chargeAppointmentAndNotify(
  appt: { id: string; appointmentRef: string; appointmentType: string; doctorId: string | null; hospitalId: string | null },
  phone: string,
  waPhoneNumber: string
): Promise<{ success: boolean; error?: string }> {
  let fee: number | null = null;
  if (appt.appointmentType === 'teleconsult' && appt.doctorId) {
    const doctor = await prisma.doctor.findUnique({ where: { id: appt.doctorId } });
    fee = doctor?.teleconsultFee ? Number(doctor.teleconsultFee) : null;
  } else if (appt.appointmentType === 'in_person' && appt.hospitalId) {
    const hospital = await prisma.hospital.findUnique({ where: { hospitalId: appt.hospitalId } });
    fee = hospital?.flatBookingFee ? Number(hospital.flatBookingFee) : null;
  }
  if (!fee) return { success: false, error: 'no_fee_on_file' };
  try {
    const data = await requestPayment(appt.id, phone, fee);
    const ussdLine = data.ussd_code
      ? `Dial *${data.ussd_code}*${data.operator ? ` (${data.operator})` : ''} on your phone to complete the payment.`
      : `Check your phone for the Mobile Money prompt to complete the payment.`;
    await sendTextMessage(
      waPhoneNumber,
      `💰 *Payment requested!*\n\n${ussdLine}\n\nAmount: *${fee.toLocaleString()} XAF*\nAppointment ref: ${appt.appointmentRef}`
    );
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}
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
    description: "List hospitals a patient can book an in-person appointment at, optionally filtered by city. Each result includes that hospital's listed services (e.g. 'Hepatitis B Testing') — check these before telling a patient a service isn't available anywhere in a city.",
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
    description: 'List verified doctors available for teleconsult. Filter by specialty, or by name if the patient asks for a specific doctor by name — use name, not specialty, when they mention a doctor\'s name. Each result includes has_photo — use send_doctor_photo once the patient has picked a specific doctor if it\'s true.',
    input_schema: {
      type: 'object',
      properties: {
        specialty: { type: 'string' },
        name: { type: 'string', description: "The doctor's name or part of it, if the patient asked for someone specific" }
      }
    }
  },
  {
    name: 'send_doctor_photo',
    description:
      "Sends the doctor's actual profile photo as a WhatsApp image message. Call this once, right when the patient has picked a specific doctor from list_doctors and has_photo was true for that doctor — not for every doctor in a list, and not more than once per doctor per conversation. Only works for cloud-registered doctors (list_doctors); hospital roster doctors (get_hospital_doctors) don't have photos. Purely visual — doesn't replace or change anything about the booking flow itself.",
    input_schema: {
      type: 'object',
      properties: { doctor_id: { type: 'string' } },
      required: ['doctor_id']
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
    name: 'request_instant_teleconsult',
    description:
      "Ask for an immediate, real-time teleconsult instead of a scheduled one — use this when the patient wants to talk to a doctor right now (e.g. 'is there a doctor available now', urgent but non-emergency symptoms), not when they want to pick a specific date/time. This pushes the request to every doctor currently marked as accepting instant consults, and whichever one accepts first is assigned — it does not book a specific doctor_id. Tell the patient it may take up to about 90 seconds to hear back, and that payment is only requested once a doctor has actually accepted.",
    input_schema: {
      type: 'object',
      properties: {
        specialty: { type: 'string', description: 'e.g. "General Practice", "Pediatrics" — omit if the patient has no preference and any available doctor is fine' },
        notes: { type: 'string', description: "A brief note on why they want to talk to a doctor, so the doctor has context when deciding whether to accept" }
      }
    }
  },
  {
    name: 'get_my_recent_appointments',
    description:
      "Look up this patient's own recent appointments (including instant teleconsults a doctor may have just accepted) — grounded in their identity, no reference needed. Call this whenever the patient asks about payment, status, or 'my appointment' and you don't already have the exact appointment_ref from earlier in THIS conversation — never guess or reuse a request reference (e.g. one starting MVR-) as if it were an appointment_ref (starting MVA-); those are different things. Also call this before request_appointment_payment if there's any doubt whether payment was already requested — it returns the current payment_status.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'check_appointment_status',
    description: 'Check the status and payment status of an existing appointment by its reference. If you do not already have the exact appointment_ref, call get_my_recent_appointments instead — do not guess or reuse a different kind of reference (e.g. an instant-consult request ref starting MVR-) as an appointment_ref.',
    input_schema: {
      type: 'object',
      properties: { appointment_ref: { type: 'string' } },
      required: ['appointment_ref']
    }
  },
  {
    name: 'request_appointment_payment',
    description:
      "Request Mobile Money payment for a booked appointment — triggers a USSD prompt on the patient's phone. The fee is looked up automatically from the provider's own records — never ask the patient what the fee is, and never pass an amount yourself. If you do not already have the exact appointment_ref, call get_my_recent_appointments first — never guess it or reuse a different reference. If the patient claims a doctor already accepted or payment was already requested, verify with get_my_recent_appointments before acting — do not take the patient's word for it and do not invent an appointment_ref to proceed anyway.",
    input_schema: {
      type: 'object',
      properties: {
        appointment_ref: { type: 'string' },
        phone: { type: 'string', description: 'Cameroon MoMo number, format 237XXXXXXXXX' }
      },
      required: ['appointment_ref', 'phone']
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
    description: "Request Mobile Money payment for a lab order — triggers a USSD prompt on the patient's phone. The amount is looked up automatically from the order's own total — never ask the patient what it costs, and never pass an amount yourself.",
    input_schema: {
      type: 'object',
      properties: {
        order_ref: { type: 'string' },
        phone: { type: 'string', description: 'Cameroon MoMo number, format 237XXXXXXXXX' }
      },
      required: ['order_ref', 'phone']
    }
  },
  {
    name: 'register_child',
    description:
      "Register a new child for the identified guardian — call register_or_identify_patient first, this always registers the child under whoever is currently identified as the patient in this conversation. Automatically creates the child's full vaccination schedule based on their real date of birth — no separate step needed for that.",
    input_schema: {
      type: 'object',
      properties: {
        full_name: { type: 'string' },
        dob: { type: 'string', description: 'YYYY-MM-DD' },
        sex: { type: 'string', enum: ['male', 'female'] },
        relationship: { type: 'string', description: "The guardian's relationship to the child, e.g. Mother, Father, Uncle, Guardian" }
      },
      required: ['full_name', 'dob', 'relationship']
    }
  },
  {
    name: 'list_my_children',
    description: 'List every child linked to the currently identified guardian.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_child_vaccination_status',
    description:
      "Get a specific child's full vaccination schedule and status (due, overdue, or administered for each dose). Use the child_patient_id from list_my_children — never guess or invent one.",
    input_schema: {
      type: 'object',
      properties: { child_patient_id: { type: 'string' } },
      required: ['child_patient_id']
    }
  },
  {
    name: 'report_vaccination_taken',
    description:
      "A guardian self-reports that one or more of their child's vaccines have already been given (e.g. at a different facility). This is recorded as guardian-reported, NOT as clinically verified — a doctor still needs to confirm it during a real visit. Match vaccine_names against what get_child_vaccination_status actually returned; never guess a name.",
    input_schema: {
      type: 'object',
      properties: {
        child_patient_id: { type: 'string' },
        vaccine_names: { type: 'array', items: { type: 'string' }, description: 'Exact vaccine names as returned by get_child_vaccination_status' },
        reported_date: { type: 'string', description: 'YYYY-MM-DD if the guardian knows it, otherwise omit' }
      },
      required: ['child_patient_id', 'vaccine_names']
    }
  },
  {
    name: 'submit_vaccination_proof',
    description:
      "Attach an uploaded vaccination card photo as proof for a dose. Only call this immediately after the patient's message contains a [IMAGE_RECEIVED key=...] marker — use the exact key from that marker, never invent one. Ask which child and which dose the photo is for first if it isn't already clear from context.",
    input_schema: {
      type: 'object',
      properties: {
        child_patient_id: { type: 'string' },
        vaccine_name: { type: 'string', description: 'Exact vaccine name as returned by get_child_vaccination_status' },
        image_key: { type: 'string', description: 'The key from the [IMAGE_RECEIVED key=...] marker' }
      },
      required: ['child_patient_id', 'vaccine_name', 'image_key']
    }
  },
  {
    name: 'generate_vaccination_report',
    description:
      "Generate and send a PDF vaccination report for a child, delivered directly in this WhatsApp conversation as a document. Use the real child_patient_id from list_my_children.",
    input_schema: {
      type: 'object',
      properties: { child_patient_id: { type: 'string' } },
      required: ['child_patient_id']
    }
  },
  {
    name: 'generate_referral_code',
    description:
      "Generate a shareable referral code/link for someone (patient, doctor, or anyone at all — no MedVAULT account required) who wants to refer a doctor to join MedVAULT. Requires their name, phone number, and Mobile Money details for the reward payout once a referred doctor's profile is approved.",
    input_schema: {
      type: 'object',
      properties: {
        referrer_name: { type: 'string' },
        referrer_phone: { type: 'string', description: '237XXXXXXXXX' },
        referrer_momo_number: { type: 'string' },
        referrer_momo_network: { type: 'string', enum: ['MTN', 'Orange'] }
      },
      required: ['referrer_name', 'referrer_phone']
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
        include: { services: true },
        take: 15
      });
      return JSON.stringify(
        hospitals.map((h: any) => ({
          hospital_id: h.hospitalId,
          name: h.name,
          city: h.city,
          region: h.region,
          flat_booking_fee: h.flatBookingFee ? Number(h.flatBookingFee) : null,
          services: h.services.map((s: any) => s.name)
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
      return JSON.stringify({
        // Repeated here, not just once in the system prompt — a
        // reminder placed right at the point of decision is followed
        // more reliably than one stated only at the top of a long
        // prompt read many turns ago. Found via real testing where the
        // model showed this exact list before ever offering the instant-
        // vs-scheduled choice, then only corrected itself once directly
        // challenged.
        reminder: 'If you have not already asked whether the patient wants an instant or a scheduled teleconsult, ask before doing anything else with this list.',
        doctors: doctors.map((d: any) => ({
          id: d.id,
          name: d.fullName,
          specialty: d.specialty,
          consultation_types: d.consultationTypes,
          teleconsult_fee: d.teleconsultFee ? Number(d.teleconsultFee) : null,
          // profilePhotoKey isn't public, and the presence of a photo
          // isn't worth adding to the query filter above — but exposing
          // whether one exists is what makes send_doctor_photo usable at
          // all; without this the model has no way to know a photo
          // exists to send.
          has_photo: Boolean(d.profilePhotoKey)
        }))
      });
    }

    case 'send_doctor_photo': {
      const doctor = await prisma.doctor.findUnique({ where: { id: input.doctor_id } });
      if (!doctor?.profilePhotoKey) {
        return JSON.stringify({ sent: false, reason: 'no_photo_on_file' });
      }
      try {
        // sendImageMessage needs a URL Meta's servers can fetch directly
        // at send time — the public proxy endpoint works fine for this
        // even though it's also what the patient portal's <img> tags use,
        // since Meta just fetches it once immediately, the same as any
        // other outbound link (see sendDocumentMessage's own reasoning).
        await sendImageMessage(contact.waPhoneNumber, `${env.apiBaseUrl}/api/v1/doctors/${doctor.id}/photo`, doctor.fullName);
        return JSON.stringify({ sent: true });
      } catch (e: any) {
        return JSON.stringify({ sent: false, reason: e.message });
      }
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

    case 'request_instant_teleconsult': {
      if (!contact.globalPatientId) {
        return JSON.stringify({ error: 'patient_not_registered', message: 'Call register_or_identify_patient first.' });
      }
      const result = await createInstantRequest({
        globalPatientId: contact.globalPatientId,
        waPhoneNumber: contact.waPhoneNumber,
        specialty: input.specialty,
        notes: input.notes
      });
      if (!result.ok) {
        return JSON.stringify({
          success: false,
          reason: result.reason,
          message: 'No doctors are currently available for an instant consult. Offer a scheduled appointment instead via list_doctors / get_doctor_availability.'
        });
      }
      return JSON.stringify({
        success: true,
        request_ref: result.requestRef,
        dispatched_to_doctors: result.dispatchedCount,
        expires_in_seconds: result.expiresInSeconds,
        message: 'Request sent. The patient will be messaged directly and automatically the moment a doctor accepts — no need to keep polling this.'
      });
    }

    case 'get_my_recent_appointments': {
      if (!contact.globalPatientId) {
        return JSON.stringify({ error: 'patient_not_registered', message: 'Call register_or_identify_patient first.' });
      }
      const appts = await prisma.appointment.findMany({
        where: { globalPatientId: contact.globalPatientId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { doctor: { select: { fullName: true, teleconsultFee: true } } }
      });
      return JSON.stringify(
        appts.map((a: any) => ({
          appointment_ref: a.appointmentRef,
          doctor_name: a.doctor?.fullName ?? null,
          appointment_type: a.appointmentType,
          status: a.status,
          payment_status: a.paymentStatus,
          // The fee to actually quote the patient before payment has
          // been requested — a.paymentAmount only gets set once
          // request_appointment_payment has actually run, so it's null
          // for anything not yet paid-for, which previously left the
          // model with nothing to tell the patient except "let me check"
          // or, worse, asking the patient what to charge. fee is the
          // real, current number regardless of payment_status;
          // payment_amount (when present) is what was actually charged.
          fee: a.doctor?.teleconsultFee ? Number(a.doctor.teleconsultFee) : null,
          payment_amount: a.paymentAmount ? Number(a.paymentAmount) : null,
          created_at: a.createdAt
        }))
      );
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
      // A patient asking again ("I confirmed the payment", "please charge
      // me now") shouldn't trigger a second real Campay collection on top
      // of one already in flight or completed — found via a real instant-
      // consult case where the automatic post-claim payment request had
      // already fired (see teleconsult-request.service.ts) before the
      // patient came back to ask about it again.
      if (appt.paymentStatus === 'paid') {
        return JSON.stringify({ already: true, payment_status: 'paid', message: 'This appointment is already paid — no need to request payment again.' });
      }
      if (appt.paymentStatus === 'pending' && appt.paymentReference) {
        return JSON.stringify({
          already: true,
          payment_status: 'pending',
          message: 'A payment request is already pending on this appointment — tell the patient to check their phone for the Mobile Money prompt rather than issuing a new one.'
        });
      }
      // The fee is looked up here, server-side, from the real source of
      // truth — never accepted as a model-supplied parameter. Found via a
      // real conversation where the model, lacking any reliable way to
      // know the fee, first asked the PATIENT to go confirm the price
      // with the doctor directly, then simply accepted whatever number
      // the patient typed next ("Proceed with 15 frs") as if it were
      // verified. A price is exactly the kind of fact that must come from
      // a tool, never from what the model or the patient believes it to
      // be — matching the same principle as the pricing-hallucination
      // fix already in the system prompt, just enforced here in code
      // where it can't be talked around.
      let fee: number | null = null;
      if (appt.appointmentType === 'teleconsult' && appt.doctorId) {
        const doctor = await prisma.doctor.findUnique({ where: { id: appt.doctorId } });
        fee = doctor?.teleconsultFee ? Number(doctor.teleconsultFee) : null;
      } else if (appt.appointmentType === 'in_person' && appt.hospitalId) {
        const hospital = await prisma.hospital.findUnique({ where: { hospitalId: appt.hospitalId } });
        fee = hospital?.flatBookingFee ? Number(hospital.flatBookingFee) : null;
      }
      if (!fee) {
        return JSON.stringify({ error: 'no_fee_on_file', message: 'This provider has no fee on file for this appointment type — escalate to a human rather than asking the patient what to charge.' });
      }
      const result = await chargeAppointmentAndNotify(appt, input.phone, contact.waPhoneNumber);
      if (!result.success) {
        return JSON.stringify({ error: result.error });
      }
      return JSON.stringify({
        success: true,
        amount_charged: fee,
        note: 'This confirmation, including the exact amount and USSD instructions, was already sent directly to the patient. Do not restate the amount or USSD code yourself — a brief acknowledgment is enough if anything.'
      });
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
      const fee = order.totalCost ? Number(order.totalCost) : null;
      if (!fee) {
        return JSON.stringify({ error: 'no_total_on_file', message: 'This order has no total cost on file — escalate to a human rather than asking the patient what to charge.' });
      }
      try {
        const data = await requestLabPayment(order.id, input.phone, fee);
        const ussdLine = data.ussd_code
          ? `Dial *${data.ussd_code}*${data.operator ? ` (${data.operator})` : ''} on your phone to complete the payment.`
          : `Check your phone for the Mobile Money prompt to complete the payment.`;
        await sendTextMessage(
          contact.waPhoneNumber,
          `💰 *Payment requested!*\n\n${ussdLine}\n\nAmount: *${fee.toLocaleString()} XAF*\nOrder ref: ${order.orderRef}`
        );
        return JSON.stringify({
          success: true,
          amount_charged: fee,
          ...data,
          note: 'This confirmation, including the exact amount and USSD instructions, was already sent directly to the patient. Do not restate the amount or USSD code yourself — a brief acknowledgment is enough if anything.'
        });
      } catch (e: any) {
        return JSON.stringify({ error: e.message });
      }
    }

    case 'register_child': {
      if (!contact.globalPatientId) {
        return JSON.stringify({ error: 'guardian_not_identified', message: 'Call register_or_identify_patient first.' });
      }
      const dob = new Date(input.dob);
      const childGlobalPatientId = await generateGlobalPatientId();
      const child = await prisma.globalPatient.create({
        data: { globalPatientId: childGlobalPatientId, fullName: input.full_name, dob, sex: input.sex ?? null }
      });
      await prisma.guardianLink.create({
        data: { guardianPatientId: contact.globalPatientId, childPatientId: child.globalPatientId, relationship: input.relationship }
      });
      await createPendingVaccinationRecords(child.globalPatientId, dob);
      return JSON.stringify({ child_patient_id: child.globalPatientId, full_name: child.fullName });
    }

    case 'list_my_children': {
      if (!contact.globalPatientId) {
        return JSON.stringify({ error: 'guardian_not_identified', message: 'Call register_or_identify_patient first.' });
      }
      const links = await prisma.guardianLink.findMany({ where: { guardianPatientId: contact.globalPatientId } });
      const childIds = links.map((l: any) => l.childPatientId);
      const children = await prisma.globalPatient.findMany({ where: { globalPatientId: { in: childIds } } });
      const relationshipByChild = new Map<string, string>(links.map((l: any) => [l.childPatientId, l.relationship]));
      return JSON.stringify({
        children: children.map((c: any) => ({
          child_patient_id: c.globalPatientId,
          full_name: c.fullName,
          dob: c.dob,
          relationship: relationshipByChild.get(c.globalPatientId)
        }))
      });
    }

    case 'get_child_vaccination_status': {
      const records = await prisma.vaccinationRecord.findMany({
        where: { childPatientId: input.child_patient_id },
        include: { scheduleItem: true },
        orderBy: { scheduledDate: 'asc' }
      });
      if (records.length === 0) return JSON.stringify({ found: false });
      return JSON.stringify({
        found: true,
        vaccinations: records.map((r: any) => ({
          vaccine_name: r.scheduleItem.vaccineName,
          scheduled_date: r.scheduledDate,
          status: r.status,
          administered_at: r.administeredAt
        }))
      });
    }

    case 'report_vaccination_taken': {
      const records = await prisma.vaccinationRecord.findMany({
        where: { childPatientId: input.child_patient_id },
        include: { scheduleItem: true }
      });
      const updated: string[] = [];
      const notFound: string[] = [];
      for (const name of input.vaccine_names as string[]) {
        const record = records.find((r: any) => r.scheduleItem.vaccineName.toLowerCase() === name.toLowerCase());
        if (!record) {
          notFound.push(name);
          continue;
        }
        await prisma.vaccinationRecord.update({
          where: { id: record.id },
          data: {
            status: 'parent_reported',
            reportedByGuardianAt: new Date(),
            reportedDate: input.reported_date ? new Date(input.reported_date) : null
          }
        });
        updated.push(name);
      }
      return JSON.stringify({ updated, not_found: notFound });
    }

    case 'submit_vaccination_proof': {
      const records = await prisma.vaccinationRecord.findMany({
        where: { childPatientId: input.child_patient_id },
        include: { scheduleItem: true }
      });
      const record = records.find((r: any) => r.scheduleItem.vaccineName.toLowerCase() === (input.vaccine_name as string).toLowerCase());
      if (!record) return JSON.stringify({ success: false, error: 'vaccine_not_found_for_this_child' });

      await prisma.vaccinationRecord.update({
        where: { id: record.id },
        data: {
          proofImageKey: input.image_key,
          proofSubmittedAt: new Date(),
          status: record.status === 'administered' ? 'administered' : 'proof_submitted'
        }
      });
      return JSON.stringify({ success: true });
    }

    case 'generate_vaccination_report': {
      const report = await generateVaccinationReportPdf(input.child_patient_id);
      if (!report) return JSON.stringify({ success: false, error: 'child_not_found' });
      await sendDocumentMessage(contact.waPhoneNumber, report.url, report.filename, 'MedVAULT Vaccination Report');
      return JSON.stringify({ success: true, sent: true });
    }

    case 'generate_referral_code': {
      const code = generateReferralCode();
      await prisma.referralCode.create({
        data: {
          code,
          referrerName: input.referrer_name,
          referrerPhone: input.referrer_phone,
          referrerMomoNumber: input.referrer_momo_number,
          referrerMomoNetwork: input.referrer_momo_network
        }
      });
      return JSON.stringify({
        code,
        share_link: `${env.webAppUrl}/doctor-register?ref=${code}`,
        reward_amount: 1000
      });
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
// OpenAI's function-calling format wraps the same JSON Schema shape
// Anthropic uses for input_schema — the schema content itself doesn't
// need converting, just the wrapper around it.
function toOpenAITools(anthropicTools: Anthropic.Tool[]): OpenAI.Chat.ChatCompletionTool[] {
  return anthropicTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>
    }
  }));
}

/**
 * Mirrors the Anthropic loop below as closely as the two APIs allow.
 * Genuinely different in a few unavoidable ways: OpenAI puts the system
 * prompt in the messages array itself rather than a separate top-level
 * param, and each tool result is its own separate 'tool' role message
 * rather than several bundled into one 'user' message the way Anthropic
 * does it. executeTool() itself needed zero changes — it was already
 * provider-agnostic (name/input/contact in, string result out).
 */
async function runOpenAIAgent(
  contact: { id: string; globalPatientId: string | null; waPhoneNumber: string },
  priorTurns: OpenAI.Chat.ChatCompletionMessageParam[],
  userText: string,
  systemNote: string | null
): Promise<{ finalText: string; messages: OpenAI.Chat.ChatCompletionMessageParam[]; contact: typeof contact }> {
  const openai = new OpenAI({ apiKey: env.openaiApiKey });
  const openaiTools = toOpenAITools(tools);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemNote ? `${SYSTEM_PROMPT}\n\n---\n${systemNote}` : SYSTEM_PROMPT },
    ...priorTurns,
    { role: 'user', content: userText }
  ];

  let finalText = '';
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      max_tokens: 512,
      // Same reasoning as the Anthropic path's temperature setting —
      // this agent needs to reproduce fixed text and follow explicit
      // procedure exactly, not vary creatively.
      temperature: 0.2,
      tools: openaiTools,
      messages
    });

    const choice = response.choices[0].message;
    const toolCalls = choice.tool_calls ?? [];

    if (toolCalls.length === 0) {
      finalText = choice.content ?? '';
      messages.push({ role: 'assistant', content: finalText });
      break;
    }

    messages.push({ role: 'assistant', content: choice.content, tool_calls: toolCalls });

    for (const toolCall of toolCalls) {
      if (toolCall.type !== 'function') continue;
      const input = JSON.parse(toolCall.function.arguments || '{}');
      const result = await executeTool(toolCall.function.name, input, contact);
      console.log(`[ai-agent:tool:openai] ${toolCall.function.name}(${JSON.stringify(input)}) -> ${result}`);
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });

      if (toolCall.function.name === 'register_or_identify_patient') {
        const refreshed = await prisma.whatsAppContact.findUnique({ where: { id: contact.id } });
        if (refreshed) contact = refreshed;
      }
    }
  }

  // Strip the system message back out before persisting — it's re-added
  // fresh from SYSTEM_PROMPT every call, storing it would just be dead
  // weight (and would go stale the moment the prompt file changes).
  const withoutSystem = messages.filter((m) => m.role !== 'system');
  return { finalText, messages: withoutSystem, contact };
}

export async function handleIncomingWhatsAppMessage(phone: string, text: string): Promise<void> {
  const activeProvider = env.aiProvider;
  const apiKeyConfigured = activeProvider === 'openai' ? !!env.openaiApiKey : !!env.anthropicApiKey;
  if (!apiKeyConfigured) {
    console.log(`[ai-agent:dev-mode] no API key set for provider '${activeProvider}' — echoing message from ${phone}: ${text}`);
    await sendTextMessage(phone, "Thanks for your message — our assistant isn't configured yet. A staff member will follow up.");
    return;
  }

  let contact = await prisma.whatsAppContact.upsert({
    where: { waPhoneNumber: phone },
    update: { lastInteractionAt: new Date() },
    create: { waPhoneNumber: phone }
  });

  const storedState = (contact.conversationState as any) ?? {};
  // If the stored conversation was built on the other provider, start
  // fresh rather than attempt to convert formats — the two APIs' tool-
  // call semantics differ enough that a faithful conversion isn't worth
  // the complexity for what is, right now, an A/B cost comparison, not a
  // guarantee to preserve history across a live provider switch.
  let priorTurns = storedState.provider === activeProvider && Array.isArray(storedState.turns) ? storedState.turns : [];

  // An explicit restart request on an EXISTING conversation is treated
  // exactly like a brand-new one from here on — same hardcoded path,
  // same guarantee. Found via real testing: "start over" turned out to
  // be the most common way this gets tested, not a rare edge case, and
  // it was falling through to the model to regenerate the menu from
  // scratch every time, reintroducing the exact verbatim-text
  // unreliability the hardcoded path exists to eliminate.
  if (RESTART_PATTERN.test(text) && (priorTurns.length > 0 || storedState.awaitingLanguageChoice)) {
    priorTurns = [];
    await sendTextMessage(phone, LANGUAGE_PROMPT);
    await prisma.whatsAppContact.update({
      where: { id: contact.id },
      data: { conversationState: { awaitingLanguageChoice: true } }
    });
    return;
  }

  // Brand-new conversation — send the fixed language prompt directly,
  // no model call at all, and wait for the reply. See the constants
  // above for why this bypasses the model entirely rather than asking
  // it to reproduce this text.
  if (priorTurns.length === 0 && !storedState.awaitingLanguageChoice) {
    await sendTextMessage(phone, LANGUAGE_PROMPT);
    await prisma.whatsAppContact.update({
      where: { id: contact.id },
      data: { conversationState: { ...storedState, awaitingLanguageChoice: true } }
    });
    return;
  }

  // Reply to the language prompt — send the fixed welcome menu directly
  // in the chosen language, then seed the model's own turn history with
  // this exact exchange so later turns know the language and know the
  // menu was already shown (matching the "don't re-show this menu"
  // instruction already in the system prompt), without ever having
  // asked the model to generate either message itself.
  if (storedState.awaitingLanguageChoice && priorTurns.length === 0) {
    const lang = detectLanguageChoice(text);
    if (lang) {
      const menu = WELCOME_MENU[lang];
      await sendTextMessage(phone, menu);
      await prisma.whatsAppContact.update({
        where: { id: contact.id },
        data: {
          conversationState: {
            provider: activeProvider,
            awaitingLanguageChoice: false,
            turns: [
              { role: 'user', content: text },
              { role: 'assistant', content: menu }
            ]
          }
        }
      });
      return;
    }
    // Didn't parse as a language choice — re-ask rather than guessing or
    // handing this specific step off to the model.
    await sendTextMessage(phone, LANGUAGE_PROMPT);
    return;
  }

  // Deterministic bare-phone-number intercept — bypasses the model
  // entirely, the same way the welcome menu does. Added after real
  // testing showed the model still saying "waiting for a doctor to
  // accept" even with an explicit, verified "a doctor ALREADY accepted"
  // fact injected directly into its own system prompt for that exact
  // request (see buildPendingInstantConsultNote below) — at that point
  // more instruction placement wasn't going to fix it reliably, and this
  // specific scenario is narrow and unambiguous enough to just handle in
  // code. Only fires when the message is essentially just a phone
  // number AND there's a genuine pending unpaid instant-consult
  // appointment on file — anything else still goes to the model as
  // normal.
  if (looksLikeBarePhoneNumber(text)) {
    const pendingAppt = await findPendingUnpaidInstantConsult(contact.globalPatientId);
    if (pendingAppt) {
      console.log(`[bare-phone-intercept] charging appointmentRef=${pendingAppt.appointmentRef} directly, bypassing the model`);
      const result = await chargeAppointmentAndNotify(pendingAppt, text, phone);
      if (!result.success) {
        await logError('bare_phone_intercept_charge_failed', new Error(JSON.stringify({ appointmentRef: pendingAppt.appointmentRef, error: result.error })));
        await sendTextMessage(phone, `A doctor has already accepted your request, but something went wrong requesting payment — our team has been notified and will follow up shortly.`);
      }
      return;
    }
  }

  let finalText: string;
  let messagesToStore: unknown;

  const pendingConsultNote = await buildPendingInstantConsultNote(contact.globalPatientId);
  console.log(`[pending-consult-note] for incoming message "${text}" from ${phone}: ${pendingConsultNote ? 'ATTACHED' : 'none'}`);

  if (activeProvider === 'openai') {
    const result = await runOpenAIAgent(
      { id: contact.id, globalPatientId: contact.globalPatientId, waPhoneNumber: contact.waPhoneNumber },
      priorTurns,
      text,
      pendingConsultNote
    );
    finalText = result.finalText;
    messagesToStore = result.messages;
    const refreshedFull = await prisma.whatsAppContact.findUnique({ where: { id: result.contact.id } });
    if (refreshedFull) contact = refreshedFull;
  } else {
    const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });
    const messages: Anthropic.MessageParam[] = [...priorTurns, { role: 'user', content: text }];

    finalText = '';
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 512,
        // This agent has to reproduce fixed text (the menu, exact
        // policy rules) and follow explicit procedure exactly — that's
        // the opposite of what a high, creativity-tuned default
        // temperature is good for. Found via repeated real cases where
        // the model paraphrased a supposedly-fixed menu item differently
        // on nearly every attempt despite explicit "copy this exactly"
        // instructions; low temperature won't make instruction-following
        // perfect, but it materially reduces this specific failure mode.
        temperature: 0.2,
        system: pendingConsultNote ? `${SYSTEM_PROMPT}\n\n---\n${pendingConsultNote}` : SYSTEM_PROMPT,
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

        if (toolUse.name === 'register_or_identify_patient') {
          const refreshed = await prisma.whatsAppContact.findUnique({ where: { id: contact.id } });
          if (refreshed) contact = refreshed;
        }
      }
      messages.push({ role: 'user', content: toolResults });
    }
    messagesToStore = truncateConversation(messages, MAX_STORED_TURNS);
  }

  if (!finalText) {
    finalText = "Sorry, I couldn't complete that — a staff member will follow up shortly.";
  }

  await sendTextMessage(phone, finalText);

  await prisma.whatsAppContact.update({
    where: { id: contact.id },
    data: { conversationState: { provider: activeProvider, turns: messagesToStore } as any }
  });
}
