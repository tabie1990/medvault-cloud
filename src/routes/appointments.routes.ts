import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { createAppointment, listPendingAppointmentsForHospital } from '../services/appointment.service.js';
import { requestPayment, checkPaymentStatus, markPaid, splitPayout } from '../services/payment.service.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export const appointmentsRouter = Router();

// Shared by request-payment and payment-status — a patient may only act
// on their own appointment, never anyone else's by guessing an ID. A
// doctor may act on any appointment (matches the original Block 3 design,
// where the doctor initiates payment collection during a call).
async function isAuthorizedForAppointmentPayment(appointmentId: string, user: { sub: string; role: string }): Promise<boolean> {
  if (user.role === 'doctor') return true;
  if (user.role === 'patient') {
    const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
    return Boolean(appt && appt.globalPatientId === user.sub);
  }
  return false;
}

appointmentsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!b.appointment_type || !b.source) {
      return res.status(400).json({ success: false, error: 'appointment_type and source are required' });
    }
    try {
      const appointment = await createAppointment({
        globalPatientId: b.global_patient_id,
        hospitalId: b.hospital_id,
        doctorId: b.doctor_id,
        appointmentType: b.appointment_type,
        requestedDate: b.requested_date,
        requestedTime: b.requested_time,
        source: b.source,
        channel: b.channel,
        notes: b.notes,
        raw: b
      });
      res.status(201).json({ success: true, appointment });
    } catch (e: any) {
      if (e.message === 'hospital_not_found') {
        return res.status(404).json({ success: false, error: 'hospital_not_found' });
      }
      throw e;
    }
  })
);

appointmentsRouter.get(
  '/hospital/:hospitalId/pending',
  asyncHandler(async (req, res) => {
    const appointments = await listPendingAppointmentsForHospital(req.params.hospitalId);
    res.json({ success: true, appointments });
  })
);

// A doctor's own appointments — needed for their dashboard. Includes any
// linked telemedicine session, since that's how the dashboard knows
// whether a session/room already exists or still needs to be started.
appointmentsRouter.get(
  '/my',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const appointments = await prisma.appointment.findMany({
      where: { doctorId: req.user!.sub },
      include: { telemedicineSession: true },
      orderBy: { requestedDate: 'asc' }
    });
    res.json({ success: true, appointments });
  })
);

const knownPaymentErrors: Record<string, number> = {
  appointment_not_found: 404,
  invalid_cameroon_phone: 400,
  campay_not_configured: 400,
  campay_returned_non_json_response: 502,
  campay_request_timed_out: 504,
  patient_has_not_paid_yet: 402,
  no_momo_number_found_for_doctor_or_hospital: 400,
  provider_payout_transfer_failed: 500
};

function handlePaymentError(e: any, res: any) {
  const status = knownPaymentErrors[e.message] ?? e.status ?? 500;
  res.status(status).json({
    success: false,
    error: e.message,
    ...(e.raw ? { raw: e.raw } : {}),
    ...(e.rawBody ? { raw_body_preview: e.rawBody } : {})
  });
}

appointmentsRouter.post(
  '/:id/request-payment',
  requireAuth('doctor', 'patient'),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!(await isAuthorizedForAppointmentPayment(req.params.id, req.user!))) {
      return res.status(403).json({ success: false, error: 'not_authorized_for_this_appointment' });
    }
    const { phone, amount } = req.body;
    if (!phone || !amount) return res.status(400).json({ success: false, error: 'phone and amount are both required' });
    try {
      const data = await requestPayment(req.params.id, phone, Number(amount));
      res.json({ success: true, ...data });
    } catch (e: any) {
      handlePaymentError(e, res);
    }
  })
);

appointmentsRouter.get(
  '/:id/payment-status',
  requireAuth('doctor', 'patient'),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!(await isAuthorizedForAppointmentPayment(req.params.id, req.user!))) {
      return res.status(403).json({ success: false, error: 'not_authorized_for_this_appointment' });
    }
    try {
      const data = await checkPaymentStatus(req.params.id);
      res.json({ success: true, ...data });
    } catch (e: any) {
      handlePaymentError(e, res);
    }
  })
);

appointmentsRouter.post(
  '/:id/mark-paid',
  requireAuth('doctor'),
  asyncHandler(async (req, res) => {
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ success: false, error: 'amount is required' });
    const appointment = await markPaid(req.params.id, Number(amount));
    res.json({ success: true, appointment });
  })
);

appointmentsRouter.post(
  '/:id/split-payout',
  requireAuth('doctor'),
  asyncHandler(async (req, res) => {
    try {
      const result = await splitPayout(req.params.id);
      res.json({ success: true, ...result });
    } catch (e: any) {
      handlePaymentError(e, res);
    }
  })
);
