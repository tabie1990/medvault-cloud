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

      if (event.event_type === 'patient.created' && !globalPatientId) {
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
    const hospitalId = String(req.query.hospital_id ?? '');
    if (!hospitalId) return res.status(400).json({ success: false, error: 'hospital_id is required' });
    const events = await prisma.syncEvent.findMany({
      where: { hospitalId, direction: 'cloud_to_hospital', status: { in: ['pending', 'queued'] } },
      orderBy: { createdAt: 'asc' },
      take: 100
    });
    res.json({ success: true, events });
  })
);
