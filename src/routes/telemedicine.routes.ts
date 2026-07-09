import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { createTelemedicineSession, updateSessionStatus } from '../services/telemedicine.service.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export const telemedicineRouter = Router();

telemedicineRouter.post(
  '/sessions',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { appointment_id } = req.body;
    if (!appointment_id) return res.status(400).json({ success: false, error: 'appointment_id is required' });
    const session = await createTelemedicineSession(appointment_id, req.user!.sub);
    res.status(201).json({ success: true, session });
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
