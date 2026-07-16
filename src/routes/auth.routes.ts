import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db/prisma.js';
import { signToken } from '../services/jwt.service.js';
import { issueOtp, verifyOtp } from '../services/otp.service.js';
import { sendPasswordResetEmail } from '../services/email.service.js';
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

/**
 * Forgot/reset password — for when someone is locked out entirely and
 * can't use the logged-in change-password endpoints above at all. Checks
 * across admin/doctor/lab-staff by identifier, same lookup order as the
 * unified login. Deliberately returns the same generic response whether
 * or not an account was actually found, and only sends an email when one
 * was — avoids letting this endpoint be used to check which emails/phones
 * have accounts on the system.
 */
authRouter.post(
  '/forgot-password',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ success: false, error: 'identifier is required' });

    const admin = await prisma.adminUser.findUnique({ where: { email: identifier } });
    const doctor = !admin ? await prisma.doctor.findFirst({ where: { OR: [{ email: identifier }, { phone: identifier }] } }) : null;
    const staff =
      !admin && !doctor ? await prisma.labStaff.findFirst({ where: { OR: [{ email: identifier }, { phone: identifier }] } }) : null;
    const account = admin ?? doctor ?? staff;

    if (account?.email) {
      const code = await issueOtp(identifier, 'password_reset');
      await sendPasswordResetEmail(account.email, code).catch((err) =>
        console.error('password reset email failed to send:', err.message)
      );
    }

    res.json({ success: true, message: 'if_account_exists_reset_code_sent' });
  })
);

authRouter.post(
  '/reset-password',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { identifier, code, new_password } = req.body;
    if (!identifier || !code || !new_password) {
      return res.status(400).json({ success: false, error: 'identifier, code, and new_password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ success: false, error: 'new_password must be at least 8 characters' });
    }

    const valid = await verifyOtp(identifier, code, 'password_reset');
    if (!valid) return res.status(401).json({ success: false, error: 'invalid_or_expired_code' });

    const passwordHash = await bcrypt.hash(new_password, 12);

    const admin = await prisma.adminUser.findUnique({ where: { email: identifier } });
    if (admin) {
      await prisma.adminUser.update({ where: { id: admin.id }, data: { passwordHash, mustChangePassword: false } });
      return res.json({ success: true });
    }

    const doctor = await prisma.doctor.findFirst({ where: { OR: [{ email: identifier }, { phone: identifier }] } });
    if (doctor) {
      await prisma.doctor.update({ where: { id: doctor.id }, data: { passwordHash, mustChangePassword: false } });
      return res.json({ success: true });
    }

    const staff = await prisma.labStaff.findFirst({ where: { OR: [{ email: identifier }, { phone: identifier }] } });
    if (staff) {
      await prisma.labStaff.update({ where: { id: staff.id }, data: { passwordHash, mustChangePassword: false } });
      return res.json({ success: true });
    }

    // Shouldn't be reachable — a valid OTP could only have been issued if
    // an account was found in forgot-password above — but handled
    // explicitly rather than silently falling through.
    res.status(404).json({ success: false, error: 'account_not_found' });
  })
);
