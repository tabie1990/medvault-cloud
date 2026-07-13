/**
 * One-time bootstrap for the very first AdminUser account. Deliberately
 * not an HTTP endpoint — admin accounts should never be self-service
 * registrable, that's a real security hole waiting to happen. Run this
 * once, directly on the server, then delete/ignore it (safe to leave —
 * running it again just fails with a clear "already exists" message
 * rather than creating a duplicate).
 *
 * Usage:
 *   ADMIN_EMAIL=you@med-vault.com ADMIN_NAME="Your Name" npx tsx src/scripts/seed-admin.ts
 *
 * Prints a generated temporary password once — save it, it won't be shown
 * again. Log in via POST /api/v1/auth/login, then change it immediately
 * via POST /api/v1/auth/change-password (mustChangePassword is set true).
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../db/prisma.js';
import { generateTempPassword } from '../services/id.service.js';

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const fullName = process.env.ADMIN_NAME;
  if (!email || !fullName) {
    console.error('Usage: ADMIN_EMAIL=you@med-vault.com ADMIN_NAME="Your Name" npx tsx src/scripts/seed-admin.ts');
    process.exit(1);
  }

  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) {
    console.error(`An admin with email ${email} already exists. Not creating a duplicate.`);
    process.exit(1);
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 12);
  const admin = await prisma.adminUser.create({
    data: { email, fullName, passwordHash, mustChangePassword: true }
  });

  console.log('Admin account created:');
  console.log(`  Email:    ${admin.email}`);
  console.log(`  Password: ${tempPassword}`);
  console.log('Save this password now — it will not be shown again.');
  console.log('Log in via POST /api/v1/auth/login, then change it via POST /api/v1/auth/change-password.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to seed admin:', err);
  process.exit(1);
});
