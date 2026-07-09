import { prisma } from '../db/prisma.js';
import { dispatchPendingNotifications } from '../services/notification.service.js';
import crypto from 'crypto';

/**
 * Replaces the separate sync-worker / appointment-worker apps (and Azure
 * Service Bus) with in-process polling. At the traffic level a handful of
 * hospitals actually generate, a distributed message broker solves a
 * scaling problem this system doesn't have yet. Each function below is
 * still isolated enough to lift into a real worker later if you ever
 * outgrow a single process — but don't build that until you have the
 * traffic to justify it.
 */

const INTERVAL_MS = 10_000;

async function fanOutNewAppointments() {
  const pending = await prisma.appointment.findMany({
    where: {
      status: 'pending',
      hospitalId: { not: null },
      NOT: { payload: { path: ['_synced'], equals: true } }
    },
    take: 25
  });

  for (const appt of pending) {
    if (!appt.hospitalId) continue;
    await prisma.syncEvent.create({
      data: {
        hospitalId: appt.hospitalId,
        installationId: '00000000-0000-0000-0000-000000000000',
        eventId: crypto.randomUUID(),
        eventType: 'appointment.created',
        entityType: 'appointment',
        entityId: appt.id,
        globalPatientId: appt.globalPatientId,
        payload: appt as any,
        direction: 'cloud_to_hospital',
        status: 'pending'
      }
    });
    await prisma.appointment.update({
      where: { id: appt.id },
      data: { payload: { ...(appt.payload as object), _synced: true } }
    });
  }
}

async function fanOutLabOrderEvents() {
  const orders = await prisma.labOrder.findMany({
    where: {
      hospitalId: { not: null },
      status: { in: ['requested', 'completed'] },
      NOT: { resultPayload: { path: ['_synced'], equals: true } }
    },
    take: 25
  });

  for (const order of orders) {
    if (!order.hospitalId) continue;
    await prisma.syncEvent.create({
      data: {
        hospitalId: order.hospitalId,
        installationId: '00000000-0000-0000-0000-000000000000',
        eventId: crypto.randomUUID(),
        eventType: order.status === 'completed' ? 'lab_order.completed' : 'lab_order.created',
        entityType: 'lab_order',
        entityId: order.id,
        globalPatientId: order.globalPatientId,
        payload: order as any,
        direction: 'cloud_to_hospital',
        status: 'pending'
      }
    });
    await prisma.labOrder.update({
      where: { id: order.id },
      data: { resultPayload: { ...((order.resultPayload as object) ?? {}), _synced: true } }
    });
  }
}

async function markQueuedSyncEventsProcessed() {
  const queued = await prisma.syncEvent.findMany({ where: { status: 'queued' }, take: 50 });
  for (const evt of queued) {
    await prisma.syncEvent.update({
      where: { id: evt.id },
      data: { status: 'processed', processedAt: new Date() }
    });
  }
}

export function startPollers() {
  setInterval(() => fanOutNewAppointments().catch((e) => console.error('poller:appointments', e)), INTERVAL_MS);
  setInterval(() => fanOutLabOrderEvents().catch((e) => console.error('poller:lab-orders', e)), INTERVAL_MS);
  setInterval(() => markQueuedSyncEventsProcessed().catch((e) => console.error('poller:sync-events', e)), INTERVAL_MS);
  setInterval(() => dispatchPendingNotifications().catch((e) => console.error('poller:notifications', e)), INTERVAL_MS);
  console.log('In-process pollers started (appointments, lab orders, sync events, notifications).');
}
