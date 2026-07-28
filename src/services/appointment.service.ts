import { prisma } from '../db/prisma.js';
import { generateAppointmentRef } from './id.service.js';
import { queueNotification } from './notification.service.js';

export interface CreateAppointmentInput {
  globalPatientId?: string;
  hospitalId?: string;
  doctorId?: string;
  hospitalDoctorRosterId?: string;
  appointmentType: string;
  requestedDate?: string;
  requestedTime?: string;
  source: string;
  channel?: string;
  notes?: string;
  raw?: Record<string, unknown>;
}

/**
 * Shared by the HTTP route (apps/api/src/routes/appointments.routes.ts) and
 * the WhatsApp AI agent (services/ai-agent.service.ts) — one code path for
 * "create an appointment" regardless of which channel it came from.
 */
export async function createAppointment(input: CreateAppointmentInput) {
  if (input.hospitalId) {
    const hospital = await prisma.hospital.findUnique({ where: { hospitalId: input.hospitalId } });
    if (!hospital) throw new Error('hospital_not_found');
  }

  const appointment = await prisma.appointment.create({
    data: {
      appointmentRef: generateAppointmentRef(),
      globalPatientId: input.globalPatientId,
      hospitalId: input.hospitalId,
      doctorId: input.doctorId,
      hospitalDoctorRosterId: input.hospitalDoctorRosterId,
      appointmentType: input.appointmentType,
      requestedDate: input.requestedDate ? new Date(input.requestedDate) : undefined,
      requestedTime: input.requestedTime,
      source: input.source,
      channel: input.channel,
      notes: input.notes,
      payload: (input.raw ?? {}) as any
    }
  });

  // Confirmation email, best-effort — never let a notification failure
  // block the actual booking. Queued through the same dispatcher as
  // every other notification, not sent inline, so a slow/down mail
  // server can never delay the booking response itself.
  const when = input.requestedDate ? `${input.requestedDate}${input.requestedTime ? ` at ${input.requestedTime}` : ''}` : 'a time to be confirmed';
  const emailBody = `A new ${input.appointmentType === 'teleconsult' ? 'teleconsultation' : 'in-person'} appointment has been booked.\n\nReference: ${appointment.appointmentRef}\nWhen: ${when}\n\nPlease check your MedVAULT dashboard for full details.`;
  if (input.doctorId) {
    await queueNotification({
      channel: 'email',
      recipientType: 'doctor',
      recipientRef: input.doctorId,
      templateType: 'appointment_confirmation',
      payload: { subject: `New appointment: ${appointment.appointmentRef}`, body: emailBody }
    }).catch(() => {});
  }
  if (input.hospitalId) {
    await queueNotification({
      channel: 'email',
      recipientType: 'hospital',
      recipientRef: input.hospitalId,
      templateType: 'appointment_confirmation',
      payload: { subject: `New appointment: ${appointment.appointmentRef}`, body: emailBody }
    }).catch(() => {});
  }

  return appointment;
}

export async function listPendingAppointmentsForHospital(hospitalId: string) {
  return prisma.appointment.findMany({
    where: { hospitalId, status: 'pending' },
    orderBy: { createdAt: 'asc' }
  });
}
