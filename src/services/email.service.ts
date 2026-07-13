import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

/**
 * Namecheap Private Email SMTP. Two distinct usage patterns:
 *
 * 1. Credential emails (welcome + temp password) — sent SYNCHRONOUSLY at
 *    registration time, NOT through the async Notification queue. The
 *    queue's payload persists indefinitely in the database, which is fine
 *    for "your appointment is confirmed" but not for a plaintext temporary
 *    password. The password exists only in memory and the outbound SMTP
 *    message, never written to a database row.
 * 2. Everything else (booking confirmed, lab order placed) goes through
 *    the existing Notification model's 'email' channel — see
 *    notification.service.ts.
 */

function transporter() {
  if (!env.smtpHost || !env.smtpUser || !env.smtpPassword) return null;
  return nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpPort === 465,
    auth: { user: env.smtpUser, pass: env.smtpPassword },
    // Shared cPanel hosting (Namecheap's non-"Private Email" product) puts
    // many customer domains on one physical server, whose TLS certificate
    // only covers the server's own hostname — never each customer's
    // mail.<theirdomain>.com alias. The connection is still fully
    // encrypted; this only stops requiring the certificate's name to
    // literally match the hostname we dialed, which would otherwise
    // reject every connection to this kind of shared mail server. Revisit
    // if this account ever moves to a host where the cert does match.
    tls: { rejectUnauthorized: false },
    // Short, explicit timeouts — this runs synchronously in the middle of
    // an HTTP request (registration), so a slow or silently-stuck mail
    // server must never be allowed to hang that request indefinitely.
    // nodemailer's own defaults are much longer than we want here.
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000
  });
}

/** Races the actual send against a hard timeout — belt and suspenders on
 * top of nodemailer's own timeout options above, in case a particular
 * failure mode (e.g. a connection that opens but never responds at the
 * TCP level) doesn't trigger those cleanly. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('email_send_timed_out')), ms))
  ]);
}

async function send(to: string, subject: string, text: string): Promise<void> {
  const t = transporter();
  if (!t) {
    console.log(`[email:dev-mode] would send to ${to} — ${subject}\n${text}`);
    return;
  }
  await withTimeout(t.sendMail({ from: env.emailFrom, to, subject, text }), 10000);
}

export async function sendWelcomeCredentialsEmail(
  to: string,
  identifier: string,
  tempPassword: string,
  loginUrl: string
): Promise<void> {
  await send(
    to,
    'Welcome to MedVAULT — your login details',
    `Welcome to MedVAULT.\n\nYour login: ${identifier}\nYour temporary password: ${tempPassword}\n\n` +
      `Please log in at ${loginUrl} and set your own password — you'll be asked to change it on first login.\n\n` +
      `If you didn't expect this email, please ignore it.`
  );
}
