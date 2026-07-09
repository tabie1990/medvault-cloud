import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export const notificationsRouter = Router();

notificationsRouter.post(
  '/register-device',
  requireAuth('patient', 'doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { platform, push_token } = req.body;
    if (!platform || !push_token) {
      return res.status(400).json({ success: false, error: 'platform and push_token are required' });
    }
    const device = await prisma.deviceToken.upsert({
      where: {
        ownerType_ownerRef_pushToken: {
          ownerType: req.user!.role,
          ownerRef: req.user!.sub,
          pushToken: push_token
        }
      },
      update: { platform },
      create: { ownerType: req.user!.role, ownerRef: req.user!.sub, platform, pushToken: push_token }
    });
    res.status(201).json({ success: true, device });
  })
);
