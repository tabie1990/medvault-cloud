/**
 * Seeds the "Back-to-School Plus" package offer, matching the campaign
 * flyer exactly (10,500 FCFA base price, 5 included items, max age 17,
 * +4,500 home service surcharge per the campaign brief).
 *
 * Usage:
 *   npx tsx src/scripts/seed-back-to-school-offer.ts
 *
 * Idempotent — skips if an offer with this exact name already exists,
 * rather than creating a duplicate on re-run.
 */
import { prisma } from '../db/prisma.js';

async function main() {
  const existing = await prisma.packageOffer.findFirst({ where: { name: 'Back-to-School Plus' } });
  if (existing) {
    console.log('Back-to-School Plus already exists, skipping.');
    process.exit(0);
  }

  await prisma.packageOffer.create({
    data: {
      name: 'Back-to-School Plus',
      description: 'Give your child the check-up they need before school begins.',
      includedItems: ['General consultation', 'Malaria screening', 'Blood group', 'Hemoglobin', 'Vision screening'],
      basePrice: 10500,
      homeServiceFee: 4500,
      maxChildAge: 17,
      isActive: true
    }
  });

  console.log('Back-to-School Plus offer created.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to seed Back-to-School Plus offer:', err);
  process.exit(1);
});
