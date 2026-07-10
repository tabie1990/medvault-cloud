import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { verifyHospitalHmac } from '../services/hmac.service.js';
import { generateGlobalPatientId } from '../services/id.service.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export const syncRouter = Router();

interface RawBodyRequest {
  rawBody?: string;
}

syncRouter.post(
  '/push',
  asyncHandler(async (req, res) => {
    const rawBody = (req as unknown as RawBodyRequest).rawBody ?? JSON.stringify(req.body);
    const auth = await verifyHospitalHmac(rawBody, req.headers as Record<string, string>);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.reason });

    const events = Array.isArray(req.body.events) ? req.body.events : [req.body];
    const results = [];

    for (const event of events) {
      let globalPatientId: string | null = event.global_patient_id ?? null;

      if (event.event_type === 'patient.created') {
        if (globalPatientId) {
          // The hospital already knows which global patient this is — most
          // likely a local record just created to represent someone who
          // first appeared via a cloud-originated booking (web portal/
          // WhatsApp). Don't mint a second global identity for the same
          // person; just ensure the identity map exists.
          const existingMap = await prisma.patientIdentityMap.findFirst({
            where: { hospitalId: auth.hospitalId, localPatientId: event.local_patient_id }
          });
          if (!existingMap) {
            await prisma.patientIdentityMap.create({
              data: {
                globalPatientId,
                hospitalId: auth.hospitalId,
                installationId: auth.installationId,
                hospitalPatientUuid: event.entity_id,
                localPatientId: event.local_patient_id,
                hospitalCode: event.hospital_code
              }
            });
          }
        } else {
          const existing = await prisma.patientIdentityMap.findFirst({
            where: { hospitalId: auth.hospitalId, localPatientId: event.local_patient_id }
          });
          if (existing) {
            globalPatientId = existing.globalPatientId;
          } else {
            globalPatientId = await generateGlobalPatientId();
            await prisma.globalPatient.create({
              data: {
                globalPatientId,
                primaryPhone: event.payload?.phone,
                email: event.payload?.email,
                fullName: event.payload?.name ?? event.payload?.full_name,
                dob: event.payload?.dob ? new Date(event.payload.dob) : undefined,
                sex: event.payload?.sex,
                identityConfidence: 75
              }
            });
            await prisma.patientIdentityMap.create({
              data: {
                globalPatientId,
                hospitalId: auth.hospitalId,
                installationId: auth.installationId,
                hospitalPatientUuid: event.entity_id,
                localPatientId: event.local_patient_id,
                hospitalCode: event.hospital_code
              }
            });
          }
        }
      }

      if (event.event_type === 'patient.updated') {
        const existing = await prisma.patientIdentityMap.findFirst({
          where: { hospitalId: auth.hospitalId, localPatientId: event.local_patient_id }
        });
        if (existing) {
          globalPatientId = existing.globalPatientId;
          // Only update fields actually present in the payload — a partial
          // update from the hospital shouldn't null out fields it didn't send.
          const data: Record<string, unknown> = {};
          if (event.payload?.phone !== undefined) data.primaryPhone = event.payload.phone;
          if (event.payload?.email !== undefined) data.email = event.payload.email;
          if (event.payload?.name !== undefined || event.payload?.full_name !== undefined) {
            data.fullName = event.payload.name ?? event.payload.full_name;
          }
          if (event.payload?.dob !== undefined) data.dob = new Date(event.payload.dob);
          if (event.payload?.sex !== undefined) data.sex = event.payload.sex;
          if (Object.keys(data).length > 0) {
            await prisma.globalPatient.update({ where: { globalPatientId }, data });
          }
        }
        // If this hospital has never pushed this patient before, there's
        // nothing to update yet — the eventual patient.created push (or a
        // manual backfill) establishes the identity map first.
      }

      const saved = await prisma.syncEvent.upsert({
        where: {
          hospitalId_installationId_eventId: {
            hospitalId: auth.hospitalId,
            installationId: auth.installationId,
            eventId: event.event_id
          }
        },
        update: { status: 'ignored' },
        create: {
          hospitalId: auth.hospitalId,
          installationId: auth.installationId,
          eventId: event.event_id,
          eventType: event.event_type,
          entityType: event.entity_type,
          entityId: event.entity_id,
          localPatientId: event.local_patient_id,
          globalPatientId,
          payload: event.payload,
          direction: 'hospital_to_cloud',
          status: 'queued',
          queuedAt: new Date()
        }
      });

      results.push({
        event_id: event.event_id,
        sync_event_id: saved.id,
        global_patient_id: globalPatientId,
        status: saved.status
      });
    }

    res.json({ success: true, results });
  })
);

syncRouter.get(
  '/pull',
  asyncHandler(async (req, res) => {
    // GET has no body to sign, so the client signs a fixed message: the
    // hospital_id itself. hospitalId used for the actual query comes from
    // the verified auth result, not the query string — otherwise a valid
    // signature for hospital A's installation could be replayed with a
    // different hospital_id in the query to read hospital B's events.
    const queryHospitalId = String(req.query.hospital_id ?? '');
    const auth = await verifyHospitalHmac(queryHospitalId, req.headers as Record<string, string>);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.reason });

    const events = await prisma.syncEvent.findMany({
      where: { hospitalId: auth.hospitalId, direction: 'cloud_to_hospital', status: { in: ['pending', 'queued'] } },
      orderBy: { createdAt: 'asc' },
      take: 100
    });

    // Mark as queued (delivered, awaiting acknowledgment) rather than
    // processed — the hospital may lose connectivity before it finishes
    // applying these locally, so we don't consider them done until it
    // explicitly acks via POST /sync/ack. If no ack arrives within the
    // poller's stale-queue window (see jobs/poller.ts), these get
    // automatically reset to 'pending' and redelivered on the next pull.
    if (events.length > 0) {
      await prisma.syncEvent.updateMany({
        where: { id: { in: events.map((e: any) => e.id) } },
        data: { status: 'queued', queuedAt: new Date() }
      });
    }

    res.json({ success: true, events });
  })
);

syncRouter.post(
  '/ack',
  asyncHandler(async (req, res) => {
    const rawBody = (req as unknown as RawBodyRequest).rawBody ?? JSON.stringify(req.body);
    const auth = await verifyHospitalHmac(rawBody, req.headers as Record<string, string>);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.reason });

    const syncEventIds: string[] = Array.isArray(req.body.sync_event_ids) ? req.body.sync_event_ids : [];
    if (syncEventIds.length === 0) {
      return res.status(400).json({ success: false, error: 'sync_event_ids[] is required' });
    }
    const result = await prisma.syncEvent.updateMany({
      where: { id: { in: syncEventIds }, hospitalId: auth.hospitalId, direction: 'cloud_to_hospital' },
      data: { status: 'processed', processedAt: new Date() }
    });
    res.json({ success: true, acknowledged: result.count });
  })
);
