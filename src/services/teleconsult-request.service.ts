import { prisma } from '../db/prisma.js';
import { generateRef } from './id.service.js';
import { createAppointment } from './appointment.service.js';
import { sendInteractiveButtonsMessage, sendTextMessage } from './whatsapp.service.js';
import { logError } from './error-log.service.js';

// How long a dispatched request stays open before it's considered
// abandoned. Matches the 60-120s window from the original product spec —
// picked a fixed 90s in the middle of that range rather than making it
// configurable per request; nothing about "how urgent is this" varies
// enough per-request yet to justify the extra parameter.
const REQUEST_WINDOW_SECONDS = 90;

export interface CreateInstantRequestInput {
  globalPatientId?: string;
  waPhoneNumber: string;
  specialty?: string;
  notes?: string;
}

export interface CreateInstantRequestResult {
  ok: boolean;
  reason?: 'no_doctors_available';
  requestRef?: string;
  dispatchedCount?: number;
  expiresInSeconds?: number;
}

/**
 * Finds eligible doctors and pushes the ACCEPT/DECLINE dispatch to all of
 * them at once. Does NOT wait for a response — this returns as soon as
 * the messages are sent; the actual winner is decided later, entirely by
 * whichever doctor's WhatsApp reply reaches claimInstantRequest first
 * (see whatsapp.routes.ts -> handleDoctorInteraction).
 */
export async function createInstantRequest(input: CreateInstantRequestInput): Promise<CreateInstantRequestResult> {
  const eligibleDoctors = await prisma.doctor.findMany({
    where: {
      verificationStatus: 'verified',
      acceptingInstantConsults: true,
      phone: { not: null },
      ...(input.specialty ? { specialty: { contains: input.specialty, mode: 'insensitive' } } : {})
    }
  });

  if (eligibleDoctors.length === 0) {
    return { ok: false, reason: 'no_doctors_available' };
  }

  const requestRef = generateRef('MVR');
  const expiresAt = new Date(Date.now() + REQUEST_WINDOW_SECONDS * 1000);
  // Use whichever doctor's own fee is highest as the quoted amount isn't
  // right either — instead, quote the median-ish first eligible doctor's
  // fee up front and let the actual claimant's own fee win once someone
  // accepts (see claimInstantRequest). This shown-up-front figure is
  // provisional, purely so BEN can tell the patient roughly what to
  // expect before anyone has actually accepted.
  const indicativeFee = eligibleDoctors.find((d) => d.teleconsultFee)?.teleconsultFee ?? null;

  const request = await prisma.teleconsultRequest.create({
    data: {
      requestRef,
      globalPatientId: input.globalPatientId,
      waPhoneNumber: input.waPhoneNumber,
      specialty: input.specialty,
      notes: input.notes,
      consultationFee: indicativeFee ?? undefined,
      expiresAt,
      dispatchedToDoctorIds: eligibleDoctors.map((d) => d.id)
    }
  });

  const body =
    `🔔 New MedVAULT Teleconsult Request\n\n` +
    `Specialty: ${input.specialty ?? 'General Consultation'}\n` +
    (input.notes ? `Notes: ${input.notes}\n` : '') +
    `Request expires in ${REQUEST_WINDOW_SECONDS} seconds.\n\n` +
    `First to accept gets the patient.`;

  await Promise.all(
    eligibleDoctors.map((d) =>
      sendInteractiveButtonsMessage(d.phone!, body, [
        { id: `accept:${request.id}`, title: '✅ Accept' },
        { id: `decline:${request.id}`, title: '❌ Decline' }
      ]).catch((err) => logError('instant_consult_dispatch_send_failed', new Error(JSON.stringify({ doctorId: d.id, requestId: request.id, err: String(err) }))))
    )
  );

  return { ok: true, requestRef, dispatchedCount: eligibleDoctors.length, expiresInSeconds: REQUEST_WINDOW_SECONDS };
}

export interface ClaimResult {
  outcome: 'won' | 'already_taken' | 'expired' | 'not_found';
  appointmentRef?: string;
  patientWaPhoneNumber?: string;
  fee?: number | null;
}

/**
 * The atomic claim itself. Deliberately a single conditional UPDATE
 * (`WHERE status = 'pending'`), not a read-then-write — this is exactly
 * the race the product spec's "Doctor A / B / C all tap ACCEPT" diagram
 * is about. Postgres's row-level locking on the UPDATE makes the outcome
 * correct even if two doctors' webhook events are being processed by two
 * concurrent Node event-loop turns at the exact same moment; only one
 * `updateMany` call can ever see count === 1.
 */
export async function claimInstantRequest(requestId: string, doctorId: string): Promise<ClaimResult> {
  const request = await prisma.teleconsultRequest.findUnique({ where: { id: requestId } });
  if (!request) return { outcome: 'not_found' };
  if (request.status !== 'pending' || request.expiresAt < new Date()) {
    // Lazily flip an overdue-but-still-'pending' row to 'expired' here
    // too, not just from the background sweep — a doctor tapping ACCEPT
    // a few seconds after expiry shouldn't win purely because the
    // sweep hasn't run yet in that window.
    if (request.status === 'pending' && request.expiresAt < new Date()) {
      await prisma.teleconsultRequest.updateMany({ where: { id: requestId, status: 'pending' }, data: { status: 'expired' } });
    }
    return { outcome: request.status === 'claimed' ? 'already_taken' : 'expired' };
  }

  const claim = await prisma.teleconsultRequest.updateMany({
    where: { id: requestId, status: 'pending' },
    data: { status: 'claimed', claimedByDoctorId: doctorId, claimedAt: new Date() }
  });
  if (claim.count === 0) {
    // Someone else's claim landed first between our read above and this write.
    return { outcome: 'already_taken' };
  }

  const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
  const fee = doctor?.teleconsultFee ?? request.consultationFee ?? null;

  const appointment = await createAppointment({
    globalPatientId: request.globalPatientId ?? undefined,
    doctorId,
    appointmentType: 'teleconsult',
    source: 'whatsapp',
    channel: 'ben_instant_consult',
    notes: request.notes ?? undefined,
    raw: { instantConsultRequestId: request.id, instantConsultRequestRef: request.requestRef }
  });

  await prisma.teleconsultRequest.update({ where: { id: requestId }, data: { appointmentId: appointment.id } });

  // Deliberately NOT auto-requesting payment here anymore. The earlier
  // version passed the patient's own WhatsApp number straight to Campay
  // as if it were their Mobile Money number — wrong in general (a
  // WhatsApp number can be from any country; Campay needs a real
  // 237-format MoMo number) and inconsistent with the scheduled-booking
  // flow, which has always asked the patient for their MoMo number
  // explicitly rather than assuming it's the same as their WhatsApp
  // number. The patient-facing message telling them a doctor accepted
  // (see doctor-whatsapp.service.ts) now asks for that number directly
  // instead; BEN picks it up from there via get_my_recent_appointments +
  // request_appointment_payment once the patient replies with it.
  return { outcome: 'won', appointmentRef: appointment.appointmentRef, patientWaPhoneNumber: request.waPhoneNumber, fee: fee ? Number(fee) : null };
}

/**
 * Tells every dispatched doctor except the winner that the request is no
 * longer available. Best-effort and fire-and-forget from the caller's
 * perspective — a losing doctor not getting this message is a minor UX
 * miss (they'd find out from the "already taken" reply if they still tap
 * ACCEPT), not something worth blocking the winner's confirmation on.
 */
export async function notifyLosingDoctors(requestId: string, winningDoctorId: string): Promise<void> {
  const request = await prisma.teleconsultRequest.findUnique({ where: { id: requestId } });
  if (!request) return;
  const dispatchedIds = (request.dispatchedToDoctorIds as string[]) ?? [];
  const losingIds = dispatchedIds.filter((id) => id !== winningDoctorId);
  if (losingIds.length === 0) return;
  const losingDoctors = await prisma.doctor.findMany({ where: { id: { in: losingIds } } });
  await Promise.all(
    losingDoctors
      .filter((d) => d.phone)
      .map((d) => sendTextMessage(d.phone!, `That teleconsult request has already been accepted by another doctor. Thanks for your quick response.`).catch(() => {}))
  );
}

/**
 * Sweeps pending requests past their expiry and notifies the patient
 * nobody was available in time. Called on an interval from server.ts —
 * same "poll rather than push" pattern as the payment/reminder pollers
 * in jobs/poller.ts, kept as its own function here since it's specific
 * to this feature rather than belonging in that shared job file.
 */
export async function expireStaleInstantRequests(): Promise<void> {
  const stale = await prisma.teleconsultRequest.findMany({
    where: { status: 'pending', expiresAt: { lt: new Date() } }
  });
  for (const request of stale) {
    await prisma.teleconsultRequest.update({ where: { id: request.id }, data: { status: 'expired' } });
    await sendTextMessage(
      request.waPhoneNumber,
      `Sorry, no doctor was available to accept your teleconsult request in time. You can try again, or I can help you book a scheduled appointment instead.`
    ).catch((err) => logError('instant_consult_expiry_notify_failed', new Error(JSON.stringify({ requestId: request.id, err: String(err) }))));
  }
}
