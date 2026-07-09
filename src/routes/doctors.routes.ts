import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db/prisma.js';
import { generateRef } from '../services/id.service.js';
import { signToken } from '../services/jwt.service.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export const doctorsRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

doctorsRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!b.full_name || (!b.phone && !b.email)) {
      return res.status(400).json({ success: false, error: 'full_name and (phone or email) are required' });
    }
    const passwordHash = b.password ? await bcrypt.hash(b.password, 12) : undefined;
    const doctor = await prisma.doctor.create({
      data: {
        doctorRef: generateRef('MVD'),
        fullName: b.full_name,
        phone: b.phone,
        email: b.email,
        passwordHash,
        specialty: b.specialty,
        licenseNumber: b.license_number,
        providerType: b.provider_type ?? 'independent'
      }
    });
    const { passwordHash: _omit, ...safeDoctor } = doctor;
    res.status(201).json({ success: true, doctor: safeDoctor });
  })
);

doctorsRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { identifier, password } = req.body; // identifier = phone or email
    if (!identifier || !password) {
      return res.status(400).json({ success: false, error: 'identifier and password are required' });
    }
    const doctor = await prisma.doctor.findFirst({
      where: { OR: [{ email: identifier }, { phone: identifier }] }
    });
    if (!doctor?.passwordHash || !(await bcrypt.compare(password, doctor.passwordHash))) {
      return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }
    const token = signToken({ sub: doctor.id, role: 'doctor' });
    res.json({ success: true, token, doctor_id: doctor.id, doctor_ref: doctor.doctorRef });
  })
);

doctorsRouter.get(
  '/me',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const doctor = await prisma.doctor.findUnique({ where: { id: req.user!.sub } });
    if (!doctor) return res.status(404).json({ success: false, error: 'doctor_not_found' });
    const { passwordHash: _omit, ...safeDoctor } = doctor;
    res.json({ success: true, doctor: safeDoctor });
  })
);
