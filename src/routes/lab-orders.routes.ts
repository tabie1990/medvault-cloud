import { Router } from 'express';
import {
  createLabOrder,
  getLabOrder,
  updateLabOrderStatus,
  listPendingLabOrdersForHospital
} from '../services/lab-order.service.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export const labOrdersRouter = Router();

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
  requireAuth('doctor'),
  asyncHandler(async (req, res) => {
    const { status, result_payload, payment_status } = req.body;
    if (!status) return res.status(400).json({ success: false, error: 'status is required' });
    const order = await updateLabOrderStatus(req.params.id, {
      status,
      resultPayload: result_payload,
      paymentStatus: payment_status
    });
    res.json({ success: true, lab_order: order });
  })
);

labOrdersRouter.get(
  '/hospital/:hospitalId/pending',
  asyncHandler(async (req, res) => {
    const orders = await listPendingLabOrdersForHospital(req.params.hospitalId);
    res.json({ success: true, lab_orders: orders });
  })
);
