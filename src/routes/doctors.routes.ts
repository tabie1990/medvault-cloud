import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db/prisma.js';
import { generateRef, generateTempPassword } from '../services/id.service.js';
import { signToken } from '../services/jwt.service.js';
import { sendWelcomeCredentialsEmail } from '../services/email.service.js';
import { getUploadUrl } from '../services/storage.service.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { env } from '../config/env.js';

export const doctorsRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

doctorsRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!b.full_name || (!b.phone && !b.email)) {
      return res.status(400).json({ success: false, error: 'full_name and (phone or email) are required' });
    }

    const dupeConditions = [b.email ? { email: b.email } : null, b.phone ? { phone: b.phone } : null].filter(
      (c): c is { email: string } | { phone: string } => c !== null
    );
    const existing = await prisma.doctor.findFirst({ where: { OR: dupeConditions } });
    if (existing) {
      return res.status(409).json({ success: false, error: 'a_doctor_with_this_email_or_phone_already_exists' });
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    const doctor = await prisma.doctor.create({
      data: {
        doctorRef: generateRef('MVD'),
        fullName: b.full_name,
        phone: b.phone,
        email: b.email,
        passwordHash,
        mustChangePassword: true,
        specialty: b.specialty,
        licenseNumber: b.license_number,
        providerType: b.provider_type ?? 'independent'
      }
    });

    if (doctor.email) {
      // Synchronous, not queued — see email.service.ts for why.
      await sendWelcomeCredentialsEmail(doctor.email, doctor.email, tempPassword, `${env.webAppUrl}/login`)
        .catch((err) => console.error('welcome email failed to send:', err.message));
    }

    const { passwordHash: _omit, ...safeDoctor } = doctor;
    res.status(201).json({
      success: true,
      doctor: safeDoctor,
      // Only outside production, to make local testing possible without a
      // configured SMTP account — mirrors the same pattern used for patient OTP.
      ...(env.nodeEnv !== 'production' ? { dev_temp_password: tempPassword } : {})
    });
  })
);

doctorsRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { identifier, password } = req.body;
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
    res.json({
      success: true,
      token,
      doctor_id: doctor.id,
      doctor_ref: doctor.doctorRef,
      must_change_password: doctor.mustChangePassword
    });
  })
);

doctorsRouter.post(
  '/change-password',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ success: false, error: 'new_password must be at least 8 characters' });
    }
    const passwordHash = await bcrypt.hash(new_password, 12);
    await prisma.doctor.update({
      where: { id: req.user!.sub },
      data: { passwordHash, mustChangePassword: false }
    });
    res.json({ success: true });
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

// Lets a doctor set where their share of a split payout should go, and
// what they charge for a teleconsult — both required before request-payment
// and split-payout in payment.service.ts can actually work for them.
doctorsRouter.patch(
  '/me',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { momo_number, momo_network, teleconsult_fee } = req.body;
    const doctor = await prisma.doctor.update({
      where: { id: req.user!.sub },
      data: {
        ...(momo_number !== undefined ? { momoNumber: momo_number } : {}),
        ...(momo_network !== undefined ? { momoNetwork: momo_network } : {}),
        ...(teleconsult_fee !== undefined ? { teleconsultFee: Number(teleconsult_fee) } : {})
      }
    });
    const { passwordHash: _omit, ...safeDoctor } = doctor;
    res.json({ success: true, doctor: safeDoctor });
  })
);

// Presigned upload URL for KYC documents — the client uploads directly to
// object storage, then submits the resulting keys via POST /kyc below.
doctorsRouter.post(
  '/kyc/upload-url',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { file_name, content_type } = req.body;
    if (!file_name || !content_type) {
      return res.status(400).json({ success: false, error: 'file_name and content_type are required' });
    }
    const result = await getUploadUrl(`doctors/${req.user!.sub}/kyc`, file_name, content_type);
    res.json({ success: true, upload_url: result.uploadUrl, key: result.key });
  })
);

doctorsRouter.post(
  '/kyc',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { national_id_key, medical_license_key, selfie_key } = req.body;
    if (!national_id_key || !medical_license_key || !selfie_key) {
      return res.status(400).json({
        success: false,
        error: 'national_id_key, medical_license_key, and selfie_key are all required'
      });
    }
    const doctor = await prisma.doctor.update({
      where: { id: req.user!.sub },
      data: {
        nationalIdDocumentKey: national_id_key,
        medicalLicenseDocumentKey: medical_license_key,
        selfieKey: selfie_key,
        verificationStatus: 'pending',
        kycSubmittedAt: new Date(),
        kycReviewedAt: null,
        kycRejectionReason: null
      }
    });
    res.json({ success: true, verification_status: doctor.verificationStatus });
  })
);
