import { prisma } from '../db/prisma.js';
import { dispatchPendingNotifications } from '../services/notification.service.js';
import { logError } from '../services/error-log.service.js';
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

/**
 * Builds the identity payload sent alongside a booking. If this hospital
 * already has a local record for this global patient (they've been seen
 * here before, possibly at a different hospital originally), that's an
 * exact, known fact — not a guess — so it's surfaced separately from the
 * phone/name/dob details used for fuzzy matching on a genuinely new patient.
 */
async function buildPatientIdentity(globalPatientId: string | null) {
  if (!globalPatientId) return null;
  const patient = await prisma.globalPatient.findUnique({ where: { globalPatientId } });
  if (!patient) return null;
  return {
    phone: patient.primaryPhone,
    fullName: patient.fullName,
    dob: patient.dob,
    sex: patient.sex
  };
}

async function findExistingLocalPatient(globalPatientId: string | null, hospitalId: string | null) {
  if (!globalPatientId || !hospitalId) return null;
  const map = await prisma.patientIdentityMap.findFirst({
    where: { globalPatientId, hospitalId }
  });
  if (!map) return null;
  return { localPatientId: map.localPatientId, hospitalCode: map.hospitalCode };
}

async function fanOutNewAppointments() {
  const pending = await prisma.appointment.findMany({
    where: {
      status: 'pending',
      hospitalId: { not: null },
      syncedToHospitalAt: null
    },
    take: 25
  });

  for (const appt of pending) {
    if (!appt.hospitalId) continue;

    const patientIdentity = await buildPatientIdentity(appt.globalPatientId);
    const existingLocalPatient = await findExistingLocalPatient(appt.globalPatientId, appt.hospitalId);

    await prisma.syncEvent.create({
      data: {
        hospitalId: appt.hospitalId,
        installationId: '00000000-0000-0000-0000-000000000000',
        eventId: crypto.randomUUID(),
        eventType: 'appointment.created',
        entityType: 'appointment',
        entityId: appt.id,
        globalPatientId: appt.globalPatientId,
        payload: { ...appt, patientIdentity, existingLocalPatient } as any,
        direction: 'cloud_to_hospital',
        status: 'pending'
      }
    });
    await prisma.appointment.update({
      where: { id: appt.id },
      data: { syncedToHospitalAt: new Date() }
    });
  }
}

async function fanOutLabOrderEvents() {
  const orders = await prisma.labOrder.findMany({
    where: {
      hospitalId: { not: null },
      OR: [
        { status: 'requested', lastSyncedStatus: null },
        { status: 'completed', NOT: { lastSyncedStatus: 'completed' } }
      ]
    },
    take: 25
  });

  for (const order of orders) {
    if (!order.hospitalId) continue;

    const patientIdentity = await buildPatientIdentity(order.globalPatientId);
    const existingLocalPatient = await findExistingLocalPatient(order.globalPatientId, order.hospitalId);

    await prisma.syncEvent.create({
      data: {
        hospitalId: order.hospitalId,
        installationId: '00000000-0000-0000-0000-000000000000',
        eventId: crypto.randomUUID(),
        eventType: order.status === 'completed' ? 'lab_order.completed' : 'lab_order.created',
        entityType: 'lab_order',
        entityId: order.id,
        globalPatientId: order.globalPatientId,
        payload: { ...order, patientIdentity, existingLocalPatient } as any,
        direction: 'cloud_to_hospital',
        status: 'pending'
      }
    });
    await prisma.labOrder.update({
      where: { id: order.id },
      data: { lastSyncedStatus: order.status }
    });
  }
}

const ACK_TIMEOUT_MINUTES = 30;

// hospital_to_cloud events: the cloud already did whatever processing it
// needs synchronously in POST /sync/push (e.g. creating the GlobalPatient),
// so 'queued' here just means "logged" — safe to finalize automatically.
async function finalizeHospitalPushedEvents() {
  const queued = await prisma.syncEvent.findMany({
    where: { status: 'queued', direction: 'hospital_to_cloud' },
    take: 50
  });
  for (const evt of queued) {
    await prisma.syncEvent.update({
      where: { id: evt.id },
      data: { status: 'processed', processedAt: new Date() }
    });
  }
}

// cloud_to_hospital events: 'queued' means "delivered via GET /sync/pull,
// awaiting the hospital's POST /sync/ack". If a hospital pulls an event but
// then loses connectivity before it can apply it locally and ack, that
// event must NOT be silently marked processed — it needs to go back to
// 'pending' so the next pull redelivers it.
async function requeueStaleUnackedEvents() {
  const cutoff = new Date(Date.now() - ACK_TIMEOUT_MINUTES * 60 * 1000);
  await prisma.syncEvent.updateMany({
    where: { status: 'queued', direction: 'cloud_to_hospital', queuedAt: { lt: cutoff } },
    data: { status: 'pending' }
  });
}

export function startPollers() {
  setInterval(() => fanOutNewAppointments().catch((e) => logError('poller:appointments', e)), INTERVAL_MS);
  setInterval(() => fanOutLabOrderEvents().catch((e) => logError('poller:lab-orders', e)), INTERVAL_MS);
  setInterval(() => finalizeHospitalPushedEvents().catch((e) => logError('poller:sync-events', e)), INTERVAL_MS);
  setInterval(() => requeueStaleUnackedEvents().catch((e) => logError('poller:sync-requeue', e)), INTERVAL_MS);
  setInterval(() => dispatchPendingNotifications().catch((e) => logError('poller:notifications', e)), INTERVAL_MS);
  console.log('In-process pollers started (appointments, lab orders, sync events, notifications).');
}
