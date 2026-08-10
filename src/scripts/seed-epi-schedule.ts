/**
 * Seeds the Cameroon EPI (Expanded Programme on Immunisation) schedule
 * — the reference data every child's vaccination tracking is built
 * against. Idempotent: safe to re-run, skips anything already present
 * by vaccine name + dueAtDays rather than creating duplicates.
 *
 * Usage:
 *   npx tsx src/scripts/seed-epi-schedule.ts
 *
 * ── Sourcing note (this version is the real one) ───────────────────
 * Rebuilt from the official Ministry of Public Health / PEV Cameroun
 * poster ("Calendrier de vaccination de l'enfant, l'adolescent(e), la
 * femme enceinte et l'adulte"), dated June 2025, WHO/Gavi/UNICEF
 * co-branded. This supersedes two earlier attempts built from general
 * knowledge and web research — several real errors are corrected here:
 *   - MenA IS part of the schedule (an earlier version removed it as
 *     "unconfirmed" — wrong; it's real, at 15 months)
 *   - Measles is a 2-dose "Measles-Rubella" series (9mo, 15mo), not a
 *     single dose, and not "MMR" (an earlier version had both wrong)
 *   - IPV is real, 2 doses (14 weeks, 9 months) — an earlier version
 *     excluded it as unconfirmed
 *   - Rotavirus is 3 doses (6/10/14 weeks), not 2
 *   - The malaria vaccine is 4 doses at 6/7/9/24 months specifically —
 *     an earlier version guessed WHO's generic pilot-country schedule,
 *     which was wrong for Cameroon's actual intervals
 *   - Hepatitis B has its own birth dose, separate from the Penta doses
 *   - Vitamin A is 4 doses (6/12/18/24mo) per this poster specifically,
 *     not an open-ended recurring series
 *
 * Deliberately NOT included, by explicit decision: TPIn (malaria
 * chemoprevention — regional, only 8 of 10 regions per the poster's own
 * footnote, and not a vaccine), MILDA (mosquito net distribution, not a
 * medical intervention), Mebendazole (dewormer). Vaccines only for now.
 *
 * Also not included: HPV (9 years — outside this system's current
 * 0-24 month tracking window).
 */
import { prisma } from '../db/prisma.js';

const EPI_SCHEDULE: { vaccineName: string; dueAtDays: number; sortOrder: number }[] = [
  // 1st contact — birth
  { vaccineName: 'OPV 0', dueAtDays: 0, sortOrder: 1 },
  { vaccineName: 'BCG', dueAtDays: 0, sortOrder: 2 },
  { vaccineName: 'Hepatitis B (birth dose)', dueAtDays: 0, sortOrder: 3 },
  // 2nd contact — 6 weeks
  { vaccineName: 'OPV 1', dueAtDays: 42, sortOrder: 4 },
  { vaccineName: 'Rotavirus 1', dueAtDays: 42, sortOrder: 5 },
  { vaccineName: 'Penta 1', dueAtDays: 42, sortOrder: 6 },
  { vaccineName: 'PCV 1', dueAtDays: 42, sortOrder: 7 },
  // 3rd contact — 10 weeks
  { vaccineName: 'OPV 2', dueAtDays: 70, sortOrder: 8 },
  { vaccineName: 'Rotavirus 2', dueAtDays: 70, sortOrder: 9 },
  { vaccineName: 'Penta 2', dueAtDays: 70, sortOrder: 10 },
  { vaccineName: 'PCV 2', dueAtDays: 70, sortOrder: 11 },
  // 4th contact — 14 weeks
  { vaccineName: 'OPV 3', dueAtDays: 98, sortOrder: 12 },
  { vaccineName: 'Rotavirus 3', dueAtDays: 98, sortOrder: 13 },
  { vaccineName: 'Penta 3', dueAtDays: 98, sortOrder: 14 },
  { vaccineName: 'PCV 3', dueAtDays: 98, sortOrder: 15 },
  { vaccineName: 'IPV 1', dueAtDays: 98, sortOrder: 16 },
  // 5th contact — 6 months
  { vaccineName: 'Vitamin A', dueAtDays: 180, sortOrder: 17 },
  { vaccineName: 'Malaria vaccine 1', dueAtDays: 180, sortOrder: 18 },
  // 6th contact — 7 months
  { vaccineName: 'Malaria vaccine 2', dueAtDays: 210, sortOrder: 19 },
  // 7th contact — 9 months
  { vaccineName: 'Measles-Rubella 1', dueAtDays: 273, sortOrder: 20 },
  { vaccineName: 'Yellow Fever', dueAtDays: 273, sortOrder: 21 },
  { vaccineName: 'IPV 2', dueAtDays: 273, sortOrder: 22 },
  { vaccineName: 'Malaria vaccine 3', dueAtDays: 273, sortOrder: 23 },
  // 8th contact — 12 months
  { vaccineName: 'Vitamin A', dueAtDays: 365, sortOrder: 24 },
  // 9th contact — 15 months
  { vaccineName: 'Measles-Rubella 2', dueAtDays: 456, sortOrder: 25 },
  { vaccineName: 'MenA/ACYW135', dueAtDays: 456, sortOrder: 26 },
  // 10th contact — 18 months
  { vaccineName: 'Vitamin A', dueAtDays: 545, sortOrder: 27 },
  // 11th contact — 24 months
  { vaccineName: 'Malaria vaccine 4', dueAtDays: 730, sortOrder: 28 },
  { vaccineName: 'Vitamin A', dueAtDays: 730, sortOrder: 29 }
];

async function main() {
  let created = 0;
  let skipped = 0;
  for (const item of EPI_SCHEDULE) {
    const existing = await prisma.vaccinationScheduleItem.findFirst({
      where: { vaccineName: item.vaccineName, dueAtDays: item.dueAtDays }
    });
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
