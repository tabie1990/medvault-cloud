import { prisma } from '../db/prisma.js';

interface AvailabilityWindow {
  dayOfWeek: number; // 0=Sunday .. 6=Saturday
  startTime: string; // "08:00"
  endTime: string; // "12:00"
}

/** Replaces a doctor's entire weekly availability template. Deliberately
 * replace-all rather than incremental add/remove — a doctor editing their
 * schedule almost always means "here's my new week," not "add one more
 * window to whatever's already there," and replace-all avoids ever
 * accumulating stale/duplicate windows from repeated edits. */
export async function setAvailability(doctorId: string, windows: AvailabilityWindow[]) {
  for (const w of windows) {
    if (w.dayOfWeek < 0 || w.dayOfWeek > 6) throw new Error('dayOfWeek must be 0-6');
    if (!/^\d{2}:\d{2}$/.test(w.startTime) || !/^\d{2}:\d{2}$/.test(w.endTime)) {
      throw new Error('startTime and endTime must be in HH:MM format');
    }
    if (w.startTime >= w.endTime) throw new Error('startTime must be before endTime');
  }

  await prisma.$transaction([
    prisma.doctorAvailability.deleteMany({ where: { doctorId } }),
    prisma.doctorAvailability.createMany({
      data: windows.map((w) => ({ doctorId, dayOfWeek: w.dayOfWeek, startTime: w.startTime, endTime: w.endTime }))
    })
  ]);

  return prisma.doctorAvailability.findMany({ where: { doctorId }, orderBy: { dayOfWeek: 'asc' } });
}

export async function getAvailability(doctorId: string) {
  return prisma.doctorAvailability.findMany({ where: { doctorId }, orderBy: { dayOfWeek: 'asc' } });
}

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

/** Generates actual bookable slots for one specific date — the doctor's
 * recurring windows for that day of week, split into their configured
 * slot length, with anything already booked removed. This is computed
 * fresh on every call rather than stored, so there's never a stale-slot
 * problem if a doctor changes their hours or an appointment gets booked
 * a moment before someone else queries the same day. */
export async function getSlotsForDate(doctorId: string, date: string): Promise<string[]> {
  const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
  if (!doctor) throw new Error('doctor_not_found');

  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
  const windows = await prisma.doctorAvailability.findMany({ where: { doctorId, dayOfWeek } });
  if (windows.length === 0) return [];

  const slotLength = doctor.teleconsultSlotMinutes;
  const allSlots: string[] = [];
  for (const w of windows) {
    let cursor = timeToMinutes(w.startTime);
    const end = timeToMinutes(w.endTime);
    while (cursor + slotLength <= end) {
      allSlots.push(minutesToTime(cursor));
      cursor += slotLength;
    }
  }

  // Exclude anything already booked for this doctor on this date —
  // matching against requestedTime on non-cancelled appointments.
  // A date range, not exact equality — requestedDate could in principle be
  // stored with any time-of-day component depending on what a client sent,
  // and an exact match would silently miss appointments (and allow
  // accidental double-booking) if that ever happens.
  const dayStart = new Date(`${date}T00:00:00Z`);
  const dayEnd = new Date(`${date}T23:59:59Z`);
  const booked = await prisma.appointment.findMany({
    where: {
      doctorId,
      requestedDate: { gte: dayStart, lte: dayEnd },
      status: { in: ['pending', 'confirmed'] }
    },
    select: { requestedTime: true }
  });
  const bookedTimes = new Set(booked.map((b: { requestedTime: string | null }) => b.requestedTime).filter(Boolean));

  return allSlots.filter((s) => !bookedTimes.has(s));
}

/** Same as above, but across the next N days — what a booking UI actually
 * wants (a date picker with slots per day), not one date at a time. */
export async function getSlotsForNextDays(doctorId: string, days: number): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    result[dateStr] = await getSlotsForDate(doctorId, dateStr);
  }
  return result;
}
