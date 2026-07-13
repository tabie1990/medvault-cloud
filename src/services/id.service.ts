import { prisma } from '../db/prisma.js';

/**
 * Uses a real Postgres sequence (see db/prisma.ts -> ensureSequences) instead
 * of `count() + 1`. Two concurrent patient.created events can never collide
 * on the same global_patient_id.
 */
export async function generateGlobalPatientId(): Promise<string> {
  const rows = (await prisma.$queryRawUnsafe(
    "SELECT nextval('global_patient_seq') as nextval"
  )) as { nextval: bigint }[];
  const n = Number(rows[0].nextval);
  return `MVG-${String(n).padStart(10, '0')}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function generateAppointmentRef(): string {
  return `MVA-${Date.now()}-${randomSuffix()}`;
}

export function generateRef(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomSuffix()}`;
}

export function generateSixDigitCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** Server-generated temporary password for doctor/lab-staff registration —
 * clients never supply their own password at signup (see ARCHITECTURE.md's
 * reasoning). Avoids visually ambiguous characters (0/O, 1/l/I). */
export function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
