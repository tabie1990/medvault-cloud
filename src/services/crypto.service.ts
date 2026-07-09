import crypto from 'crypto';
import { env } from '../config/env.js';

/**
 * Reversible AES-256-GCM encryption for secrets that the server must be able
 * to read back (e.g. a hospital installation's HMAC secret) — as opposed to
 * bcrypt, which is one-way and therefore *cannot* be used for anything the
 * server needs to recover, like computing an expected HMAC signature.
 *
 * Storing the HMAC secret this way means the client never has to resend the
 * raw secret on every sync request — the whole point of signing in the first
 * place. Only the signature travels over the wire; the server decrypts its
 * own copy to check it.
 */
const ALGORITHM = 'aes-256-gcm';

function derivedKey(): Buffer {
  return crypto.createHash('sha256').update(env.secretEncryptionKey).digest();
}

export function encryptSecret(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, derivedKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptSecret(stored: string): string {
  const [ivB64, tagB64, dataB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('malformed_encrypted_secret');
  const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}
