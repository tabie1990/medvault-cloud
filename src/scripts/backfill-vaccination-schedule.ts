/**
 * One-time backfill: after correcting the EPI schedule (removing
 * MenA/MMR, adding Rotavirus and recurring Vitamin A), existing
 * children registered under the old schedule are missing the newly
 * added items. This re-runs the same idempotent creation logic used at
 * registration for every existing child, which only adds what's
 * genuinely missing — never touches or duplicates what's already there.
 *
 * Run this AFTER seed-epi-schedule.ts and AFTER removing the incorrect
 * MenA/MMR schedule items (see the deploy doc for the exact SQL).
 *
 * Usage:
 *   npx tsx src/scripts/backfill-vaccination-schedule.ts
 */
import { prisma } from '../db/prisma.js';
import { createPendingVaccinationRecords } from '../services/pediatric.service.js';

async function main() {
  const links = await prisma.guardianLink.findMany({ select: { childPatientId: true }, distinct: ['childPatientId'] });
  let processed = 0;
  for (const link of links) {
    const child = await prisma.globalPatient.findUnique({ where: { globalPatientId: link.childPatientId } });
    if (!child?.dob) continue;
    await createPendingVaccinationRecords(child.globalPatientId, new Date(child.dob));
    processed++;
  }
  console.log(`Backfilled ${processed} children with any newly added schedule items.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
