import { Router } from 'express';
import { createAppointment, listPendingAppointmentsForHospital } from '../services/appointment.service.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export const appointmentsRouter = Router();

appointmentsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!b.appointment_type || !b.source) {
      return res.status(400).json({ success: false, error: 'appointment_type and source are required' });
    }
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
  })
);

appointmentsRouter.get(
  '/hospital/:hospitalId/pending',
  asyncHandler(async (req, res) => {
    const appointments = await listPendingAppointmentsForHospital(req.params.hospitalId);
    res.json({ success: true, appointments });
  })
);
