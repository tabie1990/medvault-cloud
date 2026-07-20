import { prisma } from '../db/prisma.js';

/**
 * Mirrors availability.service.ts exactly, for hospital-roster doctors
 * instead of cloud Doctor records. The one real difference: slot length
 * is set at the hospital level (Hospital.appointmentSlotMinutes), not per
 * doctor — a hospital's front desk runs one appointment cadence for
 * everyone, unlike independent teleconsult doctors who each set their own.
 */

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60)
    .toString()
    .padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

export async function getSlotsForDate(rosterId: string, date: string): Promise<string[]> {
  const roster = await prisma.hospitalDoctorRoster.findUnique({ where: { id: rosterId }, include: { hospital: true } });
  if (!roster) throw new Error('roster_doctor_not_found');

  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
  const windows = await prisma.hospitalDoctorWorkingHours.findMany({ where: { rosterId, dayOfWeek } });
  if (windows.length === 0) return [];

  const slotLength = roster.hospital.appointmentSlotMinutes;
  const allSlots: string[] = [];
  for (const w of windows) {
    let cursor = timeToMinutes(w.startTime);
    const end = timeToMinutes(w.endTime);
    while (cursor + slotLength <= end) {
      allSlots.push(minutesToTime(cursor));
      cursor += slotLength;
    }
  }

  // Same date-range (not exact-equality) matching as the teleconsult
  // version, for the same reason: requestedDate could carry a
  // non-midnight time component depending on the caller.
  const dayStart = new Date(`${date}T00:00:00Z`);
  const dayEnd = new Date(`${date}T23:59:59Z`);
  const booked = await prisma.appointment.findMany({
    where: {
      hospitalDoctorRosterId: rosterId,
      requestedDate: { gte: dayStart, lte: dayEnd },
      status: { in: ['pending', 'confirmed'] }
    },
    select: { requestedTime: true }
  });
  const bookedTimes = new Set(booked.map((b: { requestedTime: string | null }) => b.requestedTime).filter(Boolean));

  return allSlots.filter((s) => !bookedTimes.has(s));
}

export async function getSlotsForNextDays(rosterId: string, days: number): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    result[dateStr] = await getSlotsForDate(rosterId, dateStr);
  }
  return result;
}
