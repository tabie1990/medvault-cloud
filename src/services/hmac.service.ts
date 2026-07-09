import crypto from 'crypto';
import { prisma } from '../db/prisma.js';
import { decryptSecret } from './crypto.service.js';
import { env } from '../config/env.js';

/**
 * Verifies an offline HMS sync request. The client only ever sends a
 * signature — never the raw secret — matching the point of HMAC signing.
 * The server decrypts its own stored copy of the secret to compute the
 * expected signature and compares in constant time.
 *
 * `signedMessage` is whatever the client signed: the raw JSON body for
 * POST requests (push, ack), or a fixed string like the hospital_id for
 * GET requests that have no body (pull) — the caller decides, this
 * function just verifies against whichever message is passed in.
 */
export async function verifyHospitalHmac(
  signedMessage: string,
  headers: Record<string, string | string[] | undefined>
) {
  const hospitalId = String(headers['x-medvault-hospital-id'] ?? '');
  const installationId = String(headers['x-medvault-installation-id'] ?? '');
  const timestamp = String(headers['x-medvault-timestamp'] ?? '');
  const signature = String(headers['x-medvault-signature'] ?? '');

  if (!hospitalId || !installationId || !timestamp || !signature) {
    return { ok: false as const, reason: 'missing_hmac_headers' };
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > env.hmacClockSkewSeconds) {
    return { ok: false as const, reason: 'timestamp_outside_allowed_window' };
  }

  const installation = await prisma.hospitalInstallation.findFirst({
    where: { hospitalId, installationId, status: 'active' }
  });
  if (!installation) return { ok: false as const, reason: 'installation_not_active' };

  let secret: string;
  try {
    secret = decryptSecret(installation.hmacSecretEncrypted);
  } catch {
    return { ok: false as const, reason: 'secret_decrypt_failed' };
  }

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${signedMessage}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const signatureBuf = Buffer.from(signature, 'hex');

  const valid =
    expectedBuf.length === signatureBuf.length &&
    crypto.timingSafeEqual(expectedBuf, signatureBuf);

  if (!valid) return { ok: false as const, reason: 'invalid_signature' };

  await prisma.hospitalInstallation.update({
    where: { installationId },
    data: { lastSeenAt: new Date() }
  });

  return { ok: true as const, hospitalId, installationId };
}
