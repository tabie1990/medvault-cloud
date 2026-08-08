/**
 * Seeds the Cameroon EPI (Expanded Programme on Immunisation) schedule
 * — the reference data every child's vaccination tracking is built
 * against. Idempotent: safe to re-run, skips anything already present
 * by vaccine name rather than creating duplicates.
 *
 * Usage:
 *   npx tsx src/scripts/seed-epi-schedule.ts
 *
 * If the schedule itself ever changes, this file is the place to update
 * it — no code deploy needed elsewhere, since VaccinationScheduleItem is
 * plain data that VaccinationRecord creation reads at runtime.
 */
import { prisma } from '../db/prisma.js';

const EPI_SCHEDULE: { vaccineName: string; dueAtDays: number; sortOrder: number }[] = [
  { vaccineName: 'BCG', dueAtDays: 0, sortOrder: 1 },
  { vaccineName: 'OPV 0', dueAtDays: 0, sortOrder: 2 },
  { vaccineName: 'Penta 1', dueAtDays: 42, sortOrder: 3 }, // 6 weeks
  { vaccineName: 'OPV 1', dueAtDays: 42, sortOrder: 4 },
  { vaccineName: 'PCV 1', dueAtDays: 42, sortOrder: 5 },
  { vaccineName: 'Penta 2', dueAtDays: 70, sortOrder: 6 }, // 10 weeks
  { vaccineName: 'OPV 2', dueAtDays: 70, sortOrder: 7 },
  { vaccineName: 'PCV 2', dueAtDays: 70, sortOrder: 8 },
  { vaccineName: 'Penta 3', dueAtDays: 98, sortOrder: 9 }, // 14 weeks
  { vaccineName: 'OPV 3', dueAtDays: 98, sortOrder: 10 },
  { vaccineName: 'PCV 3', dueAtDays: 98, sortOrder: 11 },
  { vaccineName: 'IPV', dueAtDays: 98, sortOrder: 12 },
  { vaccineName: 'Vitamin A', dueAtDays: 182, sortOrder: 13 }, // 6 months
  { vaccineName: 'Measles', dueAtDays: 273, sortOrder: 14 }, // 9 months
  { vaccineName: 'Yellow Fever', dueAtDays: 273, sortOrder: 15 },
  { vaccineName: 'MenA', dueAtDays: 273, sortOrder: 16 },
  { vaccineName: 'MMR', dueAtDays: 456, sortOrder: 17 } // 15 months (midpoint of 15-18mo range)
];

async function main() {
  let created = 0;
  let skipped = 0;
  for (const item of EPI_SCHEDULE) {
    const existing = await prisma.vaccinationScheduleItem.findFirst({ where: { vaccineName: item.vaccineName } });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.vaccinationScheduleItem.create({ data: item });
    created++;
  }
  console.log(`EPI schedule seeded: ${created} created, ${skipped} already existed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to seed EPI schedule:', err);
  process.exit(1);
});
