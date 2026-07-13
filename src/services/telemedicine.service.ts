import { prisma } from '../db/prisma.js';
import { generateRef } from './id.service.js';
import { createRoom } from './daily.service.js';

export async function createTelemedicineSession(appointmentId: string, doctorId?: string) {
  const appointment = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appointment) throw new Error('appointment_not_found');
  if (appointment.appointmentType !== 'teleconsult') {
    throw new Error('appointment_is_not_a_teleconsult');
  }

  const effectiveDoctorId = doctorId ?? appointment.doctorId ?? undefined;
  if (effectiveDoctorId) {
    const doctor = await prisma.doctor.findUnique({ where: { id: effectiveDoctorId } });
    if (!doctor || doctor.verificationStatus !== 'verified') {
      throw new Error('doctor_not_kyc_verified');
    }
  }

  const existing = await prisma.telemedicineSession.findUnique({ where: { appointmentId } });
  if (existing) return existing;

  const sessionRef = generateRef('MVT');
  const roomUrl = await createRoom(sessionRef);

  return prisma.telemedicineSession.create({
    data: {
      sessionRef,
      appointmentId,
      doctorId: effectiveDoctorId,
      globalPatientId: appointment.globalPatientId ?? undefined,
      roomUrl
    }
  });
}

export async function updateSessionStatus(id: string, action: 'start' | 'end' | 'cancel' | 'no_show') {
  const now = new Date();
  if (action === 'start') {
    return prisma.telemedicineSession.update({
      where: { id },
      data: { status: 'ongoing', startedAt: now }
    });
  }
  if (action === 'end') {
    return prisma.telemedicineSession.update({
      where: { id },
      data: { status: 'completed', endedAt: now }
    });
  }
  if (action === 'cancel') {
    return prisma.telemedicineSession.update({ where: { id }, data: { status: 'cancelled' } });
  }
  return prisma.telemedicineSession.update({ where: { id }, data: { status: 'no_show' } });
}
