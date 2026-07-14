import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { createTelemedicineSession, updateSessionStatus, createRoomForSession } from '../services/telemedicine.service.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export const telemedicineRouter = Router();

telemedicineRouter.post(
  '/sessions',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { appointment_id } = req.body;
    if (!appointment_id) return res.status(400).json({ success: false, error: 'appointment_id is required' });
    try {
      const session = await createTelemedicineSession(appointment_id, req.user!.sub);
      res.status(201).json({ success: true, session });
    } catch (e: any) {
      const knownErrors: Record<string, number> = {
        appointment_not_found: 404,
        appointment_is_not_a_teleconsult: 400,
        doctor_not_kyc_verified: 403
      };
      const status = knownErrors[e.message];
      if (status) return res.status(status).json({ success: false, error: e.message });
      throw e;
    }
  })
);

telemedicineRouter.patch(
  '/sessions/:id',
  requireAuth('doctor'),
  asyncHandler(async (req, res) => {
    const { action } = req.body;
    if (!['start', 'end', 'cancel', 'no_show'].includes(action)) {
      return res.status(400).json({ success: false, error: 'action must be start | end | cancel | no_show' });
    }
    const session = await updateSessionStatus(req.params.id, action);
    res.json({ success: true, session });
  })
);

// Room creation is deliberately separate from session creation — payment
// gates the room, not the booking, matching the HMS's own tested product
// decision. Idempotent: calling this again just returns the existing room.
telemedicineRouter.post(
  '/sessions/:id/room',
  requireAuth('doctor'),
  asyncHandler(async (req, res) => {
    try {
      const session = await createRoomForSession(req.params.id);
      res.json({ success: true, session });
    } catch (e: any) {
      const knownErrors: Record<string, number> = {
        telemedicine_session_not_found: 404,
        appointment_not_paid_yet: 402
      };
      const status = knownErrors[e.message];
      if (status) return res.status(status).json({ success: false, error: e.message });
      throw e;
    }
  })
);

telemedicineRouter.get(
  '/sessions/:id',
  requireAuth('patient', 'doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const session = await prisma.telemedicineSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ success: false, error: 'session_not_found' });
    if (req.user!.role === 'patient' && session.globalPatientId !== req.user!.sub) {
      return res.status(403).json({ success: false, error: 'not_your_session' });
    }
    res.json({ success: true, session });
  })
);
