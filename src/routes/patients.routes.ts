import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db/prisma.js';
import { issueOtp, verifyOtp } from '../services/otp.service.js';
import { sendTemplateMessage, sendTextMessage } from '../services/whatsapp.service.js';
import { generateGlobalPatientId } from '../services/id.service.js';
import { signToken } from '../services/jwt.service.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { env } from '../config/env.js';

export const patientsRouter = Router();

const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });

patientsRouter.post(
  '/request-otp',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'phone is required' });

    const code = await issueOtp(phone, 'patient_login');
    // Template is what's actually needed to reach a brand-new number
    // (outside any 24-hour window), but a real deploy mistake made this
    // the *only* path — breaking login entirely for every patient while
    // the template sat in Meta's review queue, not just the new-number
    // edge case it was meant to fix. Falls back to the plain message
    // that's already proven to work, rather than an all-or-nothing swap.
    try {
      await sendTemplateMessage(phone, 'medvault_otp', 'en_US', [code], [code]);
    } catch (err: any) {
      console.error('OTP template send failed, falling back to plain message:', err.message);
      await sendTextMessage(phone, `Your MedVAULT verification code is ${code}. It expires in 5 minutes.`);
    }

    res.json({
      success: true,
      message: 'otp_sent',
      // Only ever included outside production, to make local testing possible
      // without a configured WhatsApp account.
      ...(env.nodeEnv !== 'production' ? { dev_code: code } : {})
    });
  })
);

patientsRouter.post(
  '/verify-otp',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ success: false, error: 'phone and code are required' });

    const valid = await verifyOtp(phone, code, 'patient_login');
    if (!valid) return res.status(401).json({ success: false, error: 'invalid_or_expired_code' });

    let patient = await prisma.globalPatient.findFirst({ where: { primaryPhone: phone } });
    if (!patient) {
      const globalPatientId = await generateGlobalPatientId();
      patient = await prisma.globalPatient.create({
        data: {
          globalPatientId,
          primaryPhone: phone,
          identityConfidence: 30 // cloud-only registration, not yet linked to a hospital record
        }
      });
    }

    const token = signToken({ sub: patient.globalPatientId, role: 'patient' });
    res.json({ success: true, token, global_patient_id: patient.globalPatientId });
  })
);

patientsRouter.get(
  '/:globalPatientId/timeline',
  requireAuth('patient', 'doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { globalPatientId } = req.params;
    if (req.user!.role === 'patient' && req.user!.sub !== globalPatientId) {
      return res.status(403).json({ success: false, error: 'cannot_view_another_patient' });
    }

    const [appointments, labOrders, sessions] = await Promise.all([
      prisma.appointment.findMany({ where: { globalPatientId }, orderBy: { createdAt: 'desc' } }),
      prisma.labOrder.findMany({
        where: { globalPatientId },
        orderBy: { createdAt: 'desc' },
        include: { items: { include: { labService: true } }, labProvider: true }
      }),
      prisma.telemedicineSession.findMany({ where: { globalPatientId }, orderBy: { createdAt: 'desc' } })
    ]);

    res.json({ success: true, appointments, lab_orders: labOrders, telemedicine_sessions: sessions });
  })
);
