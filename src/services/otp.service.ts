import { prisma } from '../db/prisma.js';
import { generateSixDigitCode } from './id.service.js';

// Mirrors the OtpPurpose enum in prisma/schema.prisma as a plain string union,
// so this file type-checks independently of when `prisma generate` last ran.
export type OtpPurpose = 'patient_login' | 'doctor_login';

const OTP_TTL_MINUTES = 5;

export async function issueOtp(phone: string, purpose: OtpPurpose): Promise<string> {
  const code = generateSixDigitCode();
  await prisma.otpCode.create({
    data: {
      phone,
      code,
      purpose,
      expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000)
    }
  });
  return code;
}

export async function verifyOtp(
  phone: string,
  code: string,
  purpose: OtpPurpose
): Promise<boolean> {
  const candidate = await prisma.otpCode.findFirst({
    where: { phone, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' }
  });
  if (!candidate) return false;
  if (candidate.expiresAt.getTime() < Date.now()) return false;
  if (candidate.code !== code) return false;

  await prisma.otpCode.update({
    where: { id: candidate.id },
    data: { consumedAt: new Date() }
  });
  return true;
}
