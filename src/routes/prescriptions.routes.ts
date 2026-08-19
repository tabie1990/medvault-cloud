import { Router } from 'express';
import {
  createPrescription,
  getPrescriptionsForAppointment,
  getPrescriptionsForPatient,
  markPrescriptionSent,
  generatePrescriptionPdf
} from '../services/prescription.service.js';
import { sendDocumentMessage } from '../services/whatsapp.service.js';
import { prisma } from '../db/prisma.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export const prescriptionsRouter = Router();

prescriptionsRouter.post(
  '/',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const b = req.body;
    if (!b.appointment_id || !Array.isArray(b.items)) {
      return res.status(400).json({ success: false, error: 'appointment_id and items[] are required' });
    }
    try {
      const prescription = await createPrescription({
        appointmentId: b.appointment_id,
        doctorId: req.user!.sub,
        symptoms: b.symptoms,
        diagnosis: b.diagnosis,
        notes: b.notes,
        items: b.items
      });
      res.status(201).json({ success: true, prescription });
    } catch (e: any) {
      const knownErrors: Record<string, number> = {
        appointment_not_found: 404,
        at_least_one_item_is_required: 400
      };
      const status = knownErrors[e.message];
      if (status) return res.status(status).json({ success: false, error: e.message });
      throw e;
    }
  })
);

prescriptionsRouter.get(
  '/appointment/:appointmentId',
  requireAuth('doctor', 'patient'),
  asyncHandler(async (req, res) => {
    const prescriptions = await getPrescriptionsForAppointment(req.params.appointmentId);
    res.json({ success: true, prescriptions });
  })
);

prescriptionsRouter.get(
  '/patient/:globalPatientId',
  requireAuth('doctor', 'patient'),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.user!.role === 'patient' && req.user!.sub !== req.params.globalPatientId) {
      return res.status(403).json({ success: false, error: 'not_your_prescriptions' });
    }
    const prescriptions = await getPrescriptionsForPatient(req.params.globalPatientId);
    res.json({ success: true, prescriptions });
  })
);

prescriptionsRouter.post(
  '/:id/mark-sent',
  requireAuth('doctor'),
  asyncHandler(async (req, res) => {
    const prescription = await markPrescriptionSent(req.params.id);
    res.json({ success: true, prescription });
  })
);

// Generates the actual PDF and delivers it to the patient over
// WhatsApp — the "still through the AI agent" delivery channel, using
// the same sendDocumentMessage BEN itself uses for vaccination reports,
// not a new one. This is a doctor-triggered portal action, not a BEN
// conversational tool — the patient never has to ask for it.
prescriptionsRouter.post(
  '/:id/send',
  requireAuth('doctor'),
  asyncHandler(async (req, res) => {
    const prescription = await prisma.prescription.findUnique({ where: { id: req.params.id } });
    if (!prescription) return res.status(404).json({ success: false, error: 'prescription_not_found' });
    if (!prescription.globalPatientId) {
      return res.status(400).json({ success: false, error: 'no_patient_linked_to_this_prescription' });
    }
    const contact = await prisma.whatsAppContact.findFirst({ where: { globalPatientId: prescription.globalPatientId } });
    if (!contact) {
      return res.status(400).json({ success: false, error: 'patient_has_no_whatsapp_contact_on_file' });
    }
    const pdf = await generatePrescriptionPdf(prescription.id);
    if (!pdf) return res.status(500).json({ success: false, error: 'pdf_generation_failed' });
    await sendDocumentMessage(contact.waPhoneNumber, pdf.url, pdf.filename, 'Your MedVAULT Prescription');
    const updated = await markPrescriptionSent(prescription.id);
    res.json({ success: true, prescription: updated });
  })
);

