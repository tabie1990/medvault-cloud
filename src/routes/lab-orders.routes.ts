import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import {
  createLabOrder,
  getLabOrder,
  updateLabOrderStatus,
  listPendingLabOrdersForHospital
} from '../services/lab-order.service.js';
import { requestLabPayment, checkLabPaymentStatus, markLabOrderPaid, splitLabPayout } from '../services/lab-payment.service.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export const labOrdersRouter = Router();

// A lab staff member's own lab's orders — needed for their dashboard.
// Registered here, before any /:id pattern below, since a literal path
// like this must come before a parameterized one or Express matches the
// wrong route (treating "my" as if it were an order ID) — a mistake this
// exact file already made once while building this same endpoint.
labOrdersRouter.get(
  '/my',
  requireAuth('lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const staff = await prisma.labStaff.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ success: false, error: 'lab_staff_not_found' });
    const orders = await prisma.labOrder.findMany({
      where: { labProviderId: staff.labProviderId },
      include: { items: { include: { labService: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, lab_orders: orders });
  })
);

// Shared by PATCH and the payment endpoints below — a doctor may only act
// on a lab order they referred or whose lab they own; lab staff only on
// orders belonging to their own lab. Extracted here rather than
// duplicated three more times, given how many places in this codebase
// have already been bitten by exactly that kind of drift.
async function isAuthorizedForLabOrder(order: any, user: { sub: string; role: string }): Promise<boolean> {
  if (user.role === 'doctor') {
    return order.referringDoctorId === user.sub || order.labProvider.ownerDoctorId === user.sub;
  }
  if (user.role === 'lab_staff') {
    const staff = await prisma.labStaff.findUnique({ where: { id: user.sub } });
    return Boolean(staff && staff.labProviderId === order.labProviderId);
  }
  return false;
}

labOrdersRouter.post(
  '/',
  requireAuth('patient', 'doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const b = req.body;
    if (!b.lab_provider_id || !Array.isArray(b.lab_service_ids) || !b.service_type) {
      return res
        .status(400)
        .json({ success: false, error: 'lab_provider_id, lab_service_ids[], and service_type are required' });
    }
    const order = await createLabOrder({
      globalPatientId: req.user!.role === 'patient' ? req.user!.sub : b.global_patient_id,
      hospitalId: b.hospital_id,
      referringDoctorId: req.user!.role === 'doctor' ? req.user!.sub : undefined,
      referralAppointmentId: b.referral_appointment_id,
      labProviderId: b.lab_provider_id,
      serviceType: b.service_type,
      homeAddress: b.home_address,
      scheduledDate: b.scheduled_date,
      scheduledTime: b.scheduled_time,
      labServiceIds: b.lab_service_ids,
      source: req.user!.role === 'doctor' ? 'doctor_app' : 'patient_app'
    });
    res.status(201).json({ success: true, lab_order: order });
  })
);

labOrdersRouter.get(
  '/:id',
  requireAuth('patient', 'doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const order = await getLabOrder(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'lab_order_not_found' });
    if (req.user!.role === 'patient' && order.globalPatientId !== req.user!.sub) {
      return res.status(403).json({ success: false, error: 'not_your_lab_order' });
    }
    res.json({ success: true, lab_order: order });
  })
);

labOrdersRouter.patch(
  '/:id',
  requireAuth('doctor', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { status, result_payload } = req.body;
    if (!status) return res.status(400).json({ success: false, error: 'status is required' });

    const order = await getLabOrder(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'lab_order_not_found' });

    // The actual fix: a doctor can only touch a lab order they referred or
    // whose lab they own — not any arbitrary doctor. Lab staff can only
    // touch orders belonging to their own lab.
    if (!(await isAuthorizedForLabOrder(order, req.user!))) {
      return res.status(403).json({ success: false, error: 'not_authorized_for_this_lab_order' });
    }

    const updated = await updateLabOrderStatus(req.params.id, {
      status,
      resultPayload: result_payload
    });
    res.json({ success: true, lab_order: updated });
  })
);

labOrdersRouter.get(
  '/hospital/:hospitalId/pending',
  asyncHandler(async (req, res) => {
    const orders = await listPendingLabOrdersForHospital(req.params.hospitalId);
    res.json({ success: true, lab_orders: orders });
  })
);

const knownLabPaymentErrors: Record<string, number> = {
  lab_order_not_found: 404,
  invalid_cameroon_phone: 400,
  campay_not_configured: 400,
  campay_returned_non_json_response: 502,
  campay_request_timed_out: 504,
  patient_has_not_paid_yet: 402,
  no_momo_number_found_for_lab_or_owner: 400,
  provider_payout_transfer_failed: 500
};

function handleLabPaymentError(e: any, res: any) {
  const status = knownLabPaymentErrors[e.message] ?? e.status ?? 500;
  res.status(status).json({
    success: false,
    error: e.message,
    ...(e.raw ? { raw: e.raw } : {}),
    ...(e.rawBody ? { raw_body_preview: e.rawBody } : {})
  });
}

async function requireLabOrderAuth(req: AuthedRequest, res: any): Promise<any> {
  const order = await getLabOrder(req.params.id);
  if (!order) {
    res.status(404).json({ success: false, error: 'lab_order_not_found' });
    return null;
  }
  if (!(await isAuthorizedForLabOrder(order, req.user!))) {
    res.status(403).json({ success: false, error: 'not_authorized_for_this_lab_order' });
    return null;
  }
  return order;
}

labOrdersRouter.post(
  '/:id/request-payment',
  requireAuth('doctor', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!(await requireLabOrderAuth(req, res))) return;
    const { phone, amount } = req.body;
    if (!phone || !amount) return res.status(400).json({ success: false, error: 'phone and amount are both required' });
    try {
      const data = await requestLabPayment(req.params.id, phone, Number(amount));
      res.json({ success: true, ...data });
    } catch (e: any) {
      handleLabPaymentError(e, res);
    }
  })
);

labOrdersRouter.get(
  '/:id/payment-status',
  requireAuth('doctor', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!(await requireLabOrderAuth(req, res))) return;
    try {
      const data = await checkLabPaymentStatus(req.params.id);
      res.json({ success: true, ...data });
    } catch (e: any) {
      handleLabPaymentError(e, res);
    }
  })
);

labOrdersRouter.post(
  '/:id/mark-paid',
  requireAuth('doctor', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!(await requireLabOrderAuth(req, res))) return;
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ success: false, error: 'amount is required' });
    const order = await markLabOrderPaid(req.params.id, Number(amount));
    res.json({ success: true, lab_order: order });
  })
);

labOrdersRouter.post(
  '/:id/split-payout',
  requireAuth('doctor', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!(await requireLabOrderAuth(req, res))) return;
    try {
      const result = await splitLabPayout(req.params.id);
      res.json({ success: true, ...result });
    } catch (e: any) {
      handleLabPaymentError(e, res);
    }
  })
);
