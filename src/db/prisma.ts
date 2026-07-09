import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/**
 * global_patient_id is generated from a Postgres sequence rather than
 * `count() + 1`, so two concurrent patient.created events can never be handed
 * the same id. Idempotent — safe to call on every boot.
 */
export async function ensureSequences() {
  await prisma.$executeRawUnsafe(
    'CREATE SEQUENCE IF NOT EXISTS global_patient_seq START 1;'
  );
}
