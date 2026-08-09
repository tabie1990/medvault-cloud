/**
 * Seeds the Cameroon EPI (Expanded Programme on Immunisation) schedule
 * — the reference data every child's vaccination tracking is built
 * against. Idempotent: safe to re-run, skips anything already present
 * by vaccine name + dueAtDays rather than creating duplicates.
 *
 * Usage:
 *   npx tsx src/scripts/seed-epi-schedule.ts
 *
 * If the schedule itself ever changes, this file is the place to update
 * it — no code deploy needed elsewhere, since VaccinationScheduleItem is
 * plain data that VaccinationRecord creation reads at runtime.
 *
 * ── Sourcing note (important) ──────────────────────────────────────
 * Rebuilt from two independently cross-checked sources: Centre Pasteur
 * du Cameroun's official 0–11 month schedule (pasteur-yaounde.org) and
 * a peer-reviewed Yaoundé immunization study. An earlier version of
 * this list included MenA and MMR (not confirmed by either source —
 * removed), and was missing Rotavirus and Vitamin A's recurring nature
 * entirely (both added below).
 *
 * STILL UNCONFIRMED FOR THE EXACT AGES BELOW, included anyway because
 * the underlying evidence is strong enough not to omit it entirely:
 *   - Malaria vaccine (RTS,S/AS01) — Cameroon was the first country to
 *     add this to routine EPI in Jan 2024 per WHO/Gavi reporting, but
 *     it doesn't appear in either source document used for the rest of
 *     this list. Included below using WHO's standard 4-dose interval
 *     (the same pattern used in the original pilot countries and
 *     referenced for Cameroon's own rollout) rather than a
 *     Cameroon-specific confirmed day-count — worth confirming the
 *     exact ages against the current PEV Cameroun schedule directly.
 *
 * STILL UNCONFIRMED AND LEFT OUT, genuinely no strong evidence either way:
 *   - IPV — not listed in either source used here
 *   - HPV (adolescent, 9-14yo) — outside the 0-24 month window this
 *     schedule currently covers.
 * Get all of this confirmed by an actual clinician or the current PEV
 * Cameroun schedule directly before treating this list as final.
 */
import { prisma } from '../db/prisma.js';

const EPI_SCHEDULE: { vaccineName: string; dueAtDays: number; sortOrder: number }[] = [
  { vaccineName: 'BCG', dueAtDays: 0, sortOrder: 1 },
  { vaccineName: 'OPV 0', dueAtDays: 0, sortOrder: 2 },
  // 2nd contact — 6 weeks
  { vaccineName: 'Penta 1', dueAtDays: 42, sortOrder: 3 },
  { vaccineName: 'PCV 1', dueAtDays: 42, sortOrder: 4 },
  { vaccineName: 'OPV 1', dueAtDays: 42, sortOrder: 5 },
  { vaccineName: 'Rotavirus 1', dueAtDays: 42, sortOrder: 6 },
  // 3rd contact — 10 weeks
  { vaccineName: 'Penta 2', dueAtDays: 70, sortOrder: 7 },
  { vaccineName: 'PCV 2', dueAtDays: 70, sortOrder: 8 },
  { vaccineName: 'OPV 2', dueAtDays: 70, sortOrder: 9 },
  { vaccineName: 'Rotavirus 2', dueAtDays: 70, sortOrder: 10 },
  // 4th contact — 14 weeks
  { vaccineName: 'Penta 3', dueAtDays: 98, sortOrder: 11 },
  { vaccineName: 'PCV 3', dueAtDays: 98, sortOrder: 12 },
  { vaccineName: 'OPV 3', dueAtDays: 98, sortOrder: 13 },
  // Malaria vaccine (RTS,S/AS01) — WHO standard 4-dose schedule,
  // monthly starting ~5 months, booster ~18 months. Exact Cameroon-
  // specific day-counts not confirmed — see note above.
  { vaccineName: 'Malaria (RTS,S) 1', dueAtDays: 150, sortOrder: 14 },
  { vaccineName: 'Malaria (RTS,S) 2', dueAtDays: 180, sortOrder: 15 },
  { vaccineName: 'Malaria (RTS,S) 3', dueAtDays: 210, sortOrder: 16 },
  // 5th contact — 9 months
  { vaccineName: 'Measles', dueAtDays: 273, sortOrder: 17 },
  { vaccineName: 'Yellow Fever', dueAtDays: 273, sortOrder: 18 },
  { vaccineName: 'Malaria (RTS,S) 4 (booster)', dueAtDays: 545, sortOrder: 19 },
  // Vitamin A — recurring every 6 months from 6 months, not a single
  // dose. Seeded through 3 years; extend further here if needed rather
  // than assuming it stops.
  { vaccineName: 'Vitamin A', dueAtDays: 180, sortOrder: 20 },
  { vaccineName: 'Vitamin A', dueAtDays: 365, sortOrder: 21 },
  { vaccineName: 'Vitamin A', dueAtDays: 545, sortOrder: 22 },
  { vaccineName: 'Vitamin A', dueAtDays: 730, sortOrder: 23 },
  { vaccineName: 'Vitamin A', dueAtDays: 910, sortOrder: 24 },
  { vaccineName: 'Vitamin A', dueAtDays: 1095, sortOrder: 25 }
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
