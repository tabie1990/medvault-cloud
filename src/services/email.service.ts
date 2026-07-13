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
    auth: { user: env.smtpUser, pass: env.smtpPassword }
  });
}

async function send(to: string, subject: string, text: string): Promise<void> {
  const t = transporter();
  if (!t) {
    console.log(`[email:dev-mode] would send to ${to} — ${subject}\n${text}`);
    return;
  }
  await t.sendMail({ from: env.emailFrom, to, subject, text });
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
