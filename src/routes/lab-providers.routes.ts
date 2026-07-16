import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../db/prisma.js';
import { generateRef, generateTempPassword } from '../services/id.service.js';
import { sendWelcomeCredentialsEmail } from '../services/email.service.js';
import { getUploadUrl } from '../services/storage.service.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { env } from '../config/env.js';

export const labProvidersRouter = Router();

labProvidersRouter.post(
  '/register',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const b = req.body;
    if (!b.name || !b.service_type) {
      return res.status(400).json({ success: false, error: 'name and service_type are required' });
    }
    const labProvider = await prisma.labProvider.create({
      data: {
        providerRef: generateRef('MVL-P'),
        name: b.name,
        ownerDoctorId: req.user!.sub,
        hospitalId: b.hospital_id,
        serviceType: b.service_type,
        homeServiceFee: b.home_service_fee ?? 0,
        city: b.city,
        region: b.region
      }
    });
    res.status(201).json({ success: true, lab_provider: labProvider });
  })
);

// Owner doctor sets where this lab's share of a payout should go —
// required before split-payout in lab-payment.service.ts can work.
labProvidersRouter.patch(
  '/:id',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    if (provider.ownerDoctorId !== req.user!.sub) {
      return res.status(403).json({ success: false, error: 'not_the_owner_of_this_lab' });
    }
    const { momo_number, momo_network, home_service_fee } = req.body;
    const updated = await prisma.labProvider.update({
      where: { id: req.params.id },
      data: {
        ...(momo_number !== undefined ? { momoNumber: momo_number } : {}),
        ...(momo_network !== undefined ? { momoNetwork: momo_network } : {}),
        ...(home_service_fee !== undefined ? { homeServiceFee: Number(home_service_fee) } : {})
      }
    });
    res.json({ success: true, lab_provider: updated });
  })
);

labProvidersRouter.post(
  '/:id/services',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    if (provider.ownerDoctorId !== req.user!.sub) {
      return res.status(403).json({ success: false, error: 'not_the_owner_of_this_lab' });
    }
    const b = req.body;
    if (!b.test_name || b.base_price === undefined) {
      return res.status(400).json({ success: false, error: 'test_name and base_price are required' });
    }
    const service = await prisma.labService.create({
      data: {
        labProviderId: provider.id,
        testName: b.test_name,
        testCode: b.test_code,
        basePrice: b.base_price,
        turnaroundHours: b.turnaround_hours ?? 24
      }
    });
    res.status(201).json({ success: true, lab_service: service });
  })
);

// Filters to verified-only by default now — a pre-launch requirement
// flagged since Block 0, closed here. Pass ?include_unverified=true only
// makes sense for the owning doctor's own view of their not-yet-approved
// lab, not for general public browsing.
labProvidersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { city, service_type, include_unverified } = req.query;
    const providers = await prisma.labProvider.findMany({
      where: {
        ...(city ? { city: String(city) } : {}),
        ...(service_type ? { serviceType: service_type as any } : {}),
        ...(include_unverified === 'true' ? {} : { verificationStatus: 'verified' })
      },
      include: { services: { where: { isActive: true } } },
      take: 50
    });
    res.json({ success: true, lab_providers: providers });
  })
);

labProvidersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const provider = await prisma.labProvider.findUnique({
      where: { id: req.params.id },
      include: { services: { where: { isActive: true } } }
    });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    res.json({ success: true, lab_provider: provider });
  })
);

// ── KYC ──────────────────────────────────────────────────────────

labProvidersRouter.post(
  '/:id/kyc/upload-url',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    if (provider.ownerDoctorId !== req.user!.sub) {
      return res.status(403).json({ success: false, error: 'not_the_owner_of_this_lab' });
    }
    const { file_name, content_type } = req.body;
    if (!file_name || !content_type) {
      return res.status(400).json({ success: false, error: 'file_name and content_type are required' });
    }
    const result = await getUploadUrl(`lab-providers/${provider.id}/kyc`, file_name, content_type);
    res.json({ success: true, upload_url: result.uploadUrl, key: result.key });
  })
);

labProvidersRouter.post(
  '/:id/kyc',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    if (provider.ownerDoctorId !== req.user!.sub) {
      return res.status(403).json({ success: false, error: 'not_the_owner_of_this_lab' });
    }
    const { business_registration_number, business_registration_key, lab_accreditation_key, owner_id_key } = req.body;
    if (!business_registration_number || !business_registration_key || !owner_id_key) {
      return res.status(400).json({
        success: false,
        error: 'business_registration_number, business_registration_key, and owner_id_key are all required'
      });
    }
    const updated = await prisma.labProvider.update({
      where: { id: provider.id },
      data: {
        businessRegistrationNumber: business_registration_number,
        businessRegistrationDocumentKey: business_registration_key,
        labAccreditationDocumentKey: lab_accreditation_key,
        ownerIdDocumentKey: owner_id_key,
        verificationStatus: 'pending',
        kycSubmittedAt: new Date(),
        kycReviewedAt: null,
        kycRejectionReason: null
      }
    });
    res.json({ success: true, verification_status: updated.verificationStatus });
  })
);

// ── Lab staff — created by the owning doctor only ──────────────────

labProvidersRouter.post(
  '/:id/staff',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    if (provider.ownerDoctorId !== req.user!.sub) {
      return res.status(403).json({ success: false, error: 'not_the_owner_of_this_lab' });
    }
    const { full_name, email, phone } = req.body;
    if (!full_name || (!email && !phone)) {
      return res.status(400).json({ success: false, error: 'full_name and (email or phone) are required' });
    }
    const dupeConditions = [email ? { email } : null, phone ? { phone } : null].filter(
      (c): c is { email: string } | { phone: string } => c !== null
    );
    const existingStaff = await prisma.labStaff.findFirst({ where: { OR: dupeConditions } });
    if (existingStaff) {
      return res.status(409).json({ success: false, error: 'lab_staff_with_this_email_or_phone_already_exists' });
    }
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    const staff = await prisma.labStaff.create({
      data: { labProviderId: provider.id, fullName: full_name, email, phone, passwordHash }
    });

    if (staff.email) {
      await sendWelcomeCredentialsEmail(staff.email, staff.email, tempPassword, `${env.webAppUrl}/staff-login`)
        .catch((err) => console.error('welcome email failed to send:', err.message));
    }

    const { passwordHash: _omit, ...safeStaff } = staff;
    res.status(201).json({
      success: true,
      staff: safeStaff,
      ...(env.nodeEnv !== 'production' ? { dev_temp_password: tempPassword } : {})
    });
  })
);

labProvidersRouter.get(
  '/:id/staff',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    if (provider.ownerDoctorId !== req.user!.sub) {
      return res.status(403).json({ success: false, error: 'not_the_owner_of_this_lab' });
    }
    const staff = await prisma.labStaff.findMany({ where: { labProviderId: provider.id } });
    res.json({ success: true, staff: staff.map(({ passwordHash: _omit, ...s }: any) => s) });
  })
);
