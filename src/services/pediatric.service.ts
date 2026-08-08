import { prisma } from '../db/prisma.js';

/**
 * Creates the full set of pending VaccinationRecord rows for a child, one
 * per active VaccinationScheduleItem, with scheduledDate computed from
 * their real date of birth (dob + dueAtDays).
 *
 * Called once, at child registration — not computed on-the-fly on every
 * request — so that:
 *   1. A record exists to attach a reminder/administered-status/batch
 *      number to, the same pattern Appointment already uses.
 *   2. The schedule a child is actually being tracked against is a fixed
 *      snapshot from registration time, not silently different every
 *      time someone asks (e.g. if the EPI schedule reference data is
 *      later edited for a different cohort of children).
 *
 * Idempotent per scheduleItem — safe to call again for the same child
 * without creating duplicates, in case registration is ever retried.
 */
export async function createPendingVaccinationRecords(childPatientId: string, dob: Date): Promise<void> {
  const scheduleItems = await prisma.vaccinationScheduleItem.findMany({ where: { isActive: true } });

  for (const item of scheduleItems) {
    const existing = await prisma.vaccinationRecord.findFirst({
      where: { childPatientId, scheduleItemId: item.id }
    });
    if (existing) continue;

    const scheduledDate = new Date(dob);
    scheduledDate.setDate(scheduledDate.getDate() + item.dueAtDays);

    await prisma.vaccinationRecord.create({
      data: { childPatientId, scheduleItemId: item.id, scheduledDate, status: 'due' }
    });
  }
}
