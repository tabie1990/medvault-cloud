import { prisma } from '../db/prisma.js';
import { sendTemplateMessage } from './whatsapp.service.js';
import { env } from '../config/env.js';

// Mirrors the NotificationChannel enum in prisma/schema.prisma as a plain
// string union, so this file type-checks independently of when
// `prisma generate` last ran.
export type NotificationChannel = 'whatsapp' | 'push' | 'sms' | 'email';

interface CreateNotificationInput {
  channel: NotificationChannel;
  recipientType: 'patient' | 'doctor';
  recipientRef: string; // globalPatientId or doctor id
  templateType: string;
  payload: Record<string, unknown>;
}

export async function queueNotification(input: CreateNotificationInput) {
  return prisma.notification.create({
    data: {
      channel: input.channel,
      recipientType: input.recipientType,
      recipientRef: input.recipientRef,
      templateType: input.templateType,
      payload: input.payload as any
    }
  });
}

async function sendPush(pushToken: string, title: string, body: string) {
  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.expoAccessToken ? { Authorization: `Bearer ${env.expoAccessToken}` } : {})
    },
    body: JSON.stringify({ to: pushToken, title, body })
  });
  if (!res.ok) throw new Error(`expo_push_failed: ${res.status}`);
}

async function resolvePatientPhone(globalPatientId: string): Promise<string | null> {
  const patient = await prisma.globalPatient.findUnique({ where: { globalPatientId } });
  if (patient?.primaryPhone) return patient.primaryPhone;
  const contact = await prisma.whatsAppContact.findFirst({ where: { globalPatientId } });
  return contact?.waPhoneNumber ?? null;
}

async function resolveDoctorPhone(doctorId: string): Promise<string | null> {
  const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
  return doctor?.phone ?? null;
}

/**
 * Picks up pending notifications and sends them. Called by the in-process
 * poller (jobs/poller.ts) on an interval — no message broker involved.
 */
export async function dispatchPendingNotifications(limit = 20) {
  const pending = await prisma.notification.findMany({
    where: { status: 'pending' },
    take: limit,
    orderBy: { createdAt: 'asc' }
  });

  for (const note of pending) {
    try {
      if (note.channel === 'whatsapp') {
        const phone =
          note.recipientType === 'patient'
            ? await resolvePatientPhone(note.recipientRef)
            : await resolveDoctorPhone(note.recipientRef);
        if (!phone) throw new Error('no_phone_on_file');
        const payload = note.payload as Record<string, unknown>;
        await sendTemplateMessage(
          phone,
          note.templateType,
          'en',
          Array.isArray(payload.params) ? (payload.params as string[]) : []
        );
      } else if (note.channel === 'push') {
        const device = await prisma.deviceToken.findFirst({
          where: { ownerType: note.recipientType, ownerRef: note.recipientRef },
          orderBy: { createdAt: 'desc' }
        });
        if (!device) throw new Error('no_device_token_on_file');
        const payload = note.payload as { title?: string; body?: string };
        await sendPush(device.pushToken, payload.title ?? 'MedVAULT', payload.body ?? '');
      } else {
        throw new Error(`unsupported_channel_${note.channel}`);
      }

      await prisma.notification.update({
        where: { id: note.id },
        data: { status: 'sent', sentAt: new Date() }
      });
    } catch (err: any) {
      await prisma.notification.update({
        where: { id: note.id },
        data: { status: 'failed', errorMessage: String(err?.message ?? err) }
      });
    }
  }
}
