import { prisma } from '../db/prisma.js';
import { generateRef } from './id.service.js';

interface PrescriptionItem {
  type: 'medication' | 'lab_request' | 'imaging_request';
  name: string;
  dose?: string;
  frequency?: string;
  duration?: string;
  notes?: string;
}

export async function createPrescription(input: {
  appointmentId: string;
  doctorId: string;
  symptoms?: string;
  diagnosis?: string;
  notes?: string;
  items: PrescriptionItem[];
}) {
  const appointment = await prisma.appointment.findUnique({ where: { id: input.appointmentId } });
  if (!appointment) throw new Error('appointment_not_found');
  if (!input.items || input.items.length === 0) throw new Error('at_least_one_item_is_required');

  return prisma.prescription.create({
    data: {
      prescriptionRef: generateRef('MVRX'),
      appointmentId: input.appointmentId,
      globalPatientId: appointment.globalPatientId ?? undefined,
      doctorId: input.doctorId,
      symptoms: input.symptoms,
      diagnosis: input.diagnosis,
      notes: input.notes,
      items: input.items as any
    }
  });
}

export async function getPrescriptionsForAppointment(appointmentId: string) {
  return prisma.prescription.findMany({ where: { appointmentId }, orderBy: { createdAt: 'desc' } });
}

export async function getPrescriptionsForPatient(globalPatientId: string) {
  return prisma.prescription.findMany({ where: { globalPatientId }, orderBy: { createdAt: 'desc' } });
}

export async function markPrescriptionSent(id: string) {
  return prisma.prescription.update({ where: { id }, data: { status: 'sent_to_patient', sentAt: new Date() } });
}
