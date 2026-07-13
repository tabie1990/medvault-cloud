import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db/prisma.js';
import { signToken } from '../services/jwt.service.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

/**
 * One login endpoint for doctor, lab-staff, and admin accounts — checks
 * across all three by identifier (email or phone) + password, returns
 * whichever role matches. This is what lets a single web app share one
 * login form across all three account types instead of three separate
 * screens (see ARCHITECTURE.md's unified-app design).
 */
authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ success: false, error: 'identifier and password are required' });
    }

    const admin = await prisma.adminUser.findUnique({ where: { email: identifier } });
    if (admin && (await bcrypt.compare(password, admin.passwordHash))) {
      const token = signToken({ sub: admin.id, role: 'admin' });
      return res.json({ success: true, token, role: 'admin', must_change_password: admin.mustChangePassword });
    }

    const doctor = await prisma.doctor.findFirst({ where: { OR: [{ email: identifier }, { phone: identifier }] } });
    if (doctor?.passwordHash && (await bcrypt.compare(password, doctor.passwordHash))) {
      const token = signToken({ sub: doctor.id, role: 'doctor' });
      return res.json({
        success: true,
        token,
        role: 'doctor',
        doctor_ref: doctor.doctorRef,
        must_change_password: doctor.mustChangePassword
      });
    }

    const staff = await prisma.labStaff.findFirst({ where: { OR: [{ email: identifier }, { phone: identifier }] } });
    if (staff && (await bcrypt.compare(password, staff.passwordHash))) {
      const token = signToken({ sub: staff.id, role: 'lab_staff' });
      return res.json({
        success: true,
        token,
        role: 'lab_staff',
        lab_provider_id: staff.labProviderId,
        must_change_password: staff.mustChangePassword
      });
    }

    res.status(401).json({ success: false, error: 'invalid_credentials' });
  })
);

authRouter.post(
  '/change-password',
  requireAuth('admin', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ success: false, error: 'new_password must be at least 8 characters' });
    }
    const passwordHash = await bcrypt.hash(new_password, 12);
    if (req.user!.role === 'admin') {
      await prisma.adminUser.update({ where: { id: req.user!.sub }, data: { passwordHash, mustChangePassword: false } });
    } else {
      await prisma.labStaff.update({ where: { id: req.user!.sub }, data: { passwordHash, mustChangePassword: false } });
    }
    res.json({ success: true });
  })
);
