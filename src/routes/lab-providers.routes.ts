import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../db/prisma.js';
import { generateRef, generateTempPassword } from '../services/id.service.js';
import { sendWelcomeCredentialsEmail, sendPlainEmail } from '../services/email.service.js';
import { getUploadUrl } from '../services/storage.service.js';
import { TERMS_VERSION } from '../services/legal.service.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { env } from '../config/env.js';

export const labProvidersRouter = Router();

/**
 * A lab can now be owned two different ways — created by a doctor
 * (ownerDoctorId set), or self-registered with no owning doctor at all,
 * managed instead by its own LabStaff accounts. Every management
 * endpoint below needs to authorize both shapes, not just the original
 * doctor-owned one, or a self-registered lab would be manageable by
 * nobody at all once created.
 */
async function isAuthorizedForLab(req: AuthedRequest, provider: { id: string; ownerDoctorId: string | null }): Promise<boolean> {
  if (req.user!.role === 'doctor') return provider.ownerDoctorId === req.user!.sub;
  if (req.user!.role === 'lab_staff') {
    const staff = await prisma.labStaff.findUnique({ where: { id: req.user!.sub } });
    return staff?.labProviderId === provider.id;
  }
  return false;
}

// A doctor's own labs — needed for a "my labs" management screen.
// Registered before any /:id pattern below, same lesson learned building
// the appointments and lab-orders equivalents of this endpoint: a
// literal path must come before a parameterized one or Express matches
// the wrong route.
labProvidersRouter.get(
  '/my',
  requireAuth('doctor', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    let where: any;
    if (req.user!.role === 'doctor') {
      where = { ownerDoctorId: req.user!.sub };
    } else {
      const staff = await prisma.labStaff.findUnique({ where: { id: req.user!.sub } });
      if (!staff) return res.status(404).json({ success: false, error: 'lab_staff_not_found' });
      where = { id: staff.labProviderId };
    }
    const providers = await prisma.labProvider.findMany({
      where,
      include: { services: true, workingHours: { orderBy: { dayOfWeek: 'asc' } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, lab_providers: providers });
  })
);

// Self-registration — no doctor required. Creates the lab AND its first
// (owner) LabStaff login together, in one call, so a lab can sign up and
// get straight to submitting KYC without anyone else's account
// involved. Distinct from labProvidersRouter.post('/register',
// requireAuth('doctor'), ...) below, which is the older doctor-creates-
// a-lab path — kept as-is, unchanged, since existing doctor-owned labs
// still need it.
labProvidersRouter.post(
  '/register-self',
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!b.name || !b.service_type) {
      return res.status(400).json({ success: false, error: 'name and service_type are required' });
    }
    if (!b.owner_full_name || (!b.owner_email && !b.owner_phone)) {
      return res.status(400).json({ success: false, error: 'owner_full_name and (owner_email or owner_phone) are required' });
    }
    if (!b.password || b.password.length < 8) {
      return res.status(400).json({ success: false, error: 'password must be at least 8 characters' });
    }
    if (b.terms_accepted !== true) {
      return res.status(400).json({ success: false, error: 'terms_accepted must be true — the terms must be shown and agreed to before registering' });
    }

    const dupeConditions = [b.owner_email ? { email: b.owner_email } : null, b.owner_phone ? { phone: b.owner_phone } : null].filter(
      (c): c is { email: string } | { phone: string } => c !== null
    );
    const existingStaff = await prisma.labStaff.findFirst({ where: { OR: dupeConditions } });
    if (existingStaff) {
      return res.status(409).json({ success: false, error: 'an_account_with_this_email_or_phone_already_exists' });
    }

    const passwordHash = await bcrypt.hash(b.password, 12);
    const now = new Date();

    // One transaction — a lab created without its owner login (or vice
    // versa) would be an orphaned, unmanageable record either way.
    const { labProvider, labStaff } = await prisma.$transaction(async (tx) => {
      const labProvider = await tx.labProvider.create({
        data: {
          providerRef: generateRef('MVL-P'),
          name: b.name,
          serviceType: b.service_type,
          homeServiceFee: b.home_service_fee ?? 0,
          city: b.city,
          region: b.region
        }
      });
      const labStaff = await tx.labStaff.create({
        data: {
          labProviderId: labProvider.id,
          fullName: b.owner_full_name,
          email: b.owner_email,
          phone: b.owner_phone,
          passwordHash,
          mustChangePassword: false, // they chose this password themselves — no reason to force a change
          termsAcceptedAt: now,
          termsVersion: TERMS_VERSION
        }
      });
      return { labProvider, labStaff };
    });

    if (labStaff.email) {
      await sendPlainEmail(
        labStaff.email,
        'Welcome to MedVAULT',
        `Your lab account has been created. Log in at ${env.webAppUrl}/staff-login with the email/phone and password you just chose. Next step: submit your KYC documents to get verified before you appear to patients.`
      ).catch((err) => console.error('welcome email failed to send:', err.message));
    }

    const { passwordHash: _omit, ...safeStaff } = labStaff;
    res.status(201).json({
      success: true,
      lab_provider: labProvider,
      staff: safeStaff,
      message: 'Registered. Log in and submit KYC documents to get verified before appearing to patients.'
    });
  })
);

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
  requireAuth('doctor', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    if (!(await isAuthorizedForLab(req, provider))) {
      return res.status(403).json({ success: false, error: 'not_authorized_for_this_lab' });
    }
    const { momo_number, momo_network, home_service_fee, email } = req.body;
    const updated = await prisma.labProvider.update({
      where: { id: req.params.id },
      data: {
        ...(momo_number !== undefined ? { momoNumber: momo_number } : {}),
        ...(momo_network !== undefined ? { momoNetwork: momo_network } : {}),
        ...(home_service_fee !== undefined ? { homeServiceFee: Number(home_service_fee) } : {}),
        ...(email !== undefined ? { email } : {})
      }
    });
    res.json({ success: true, lab_provider: updated });
  })
);

// Owner doctor sets this lab's opening hours — replace-all pattern,
// same reasoning as DoctorAvailability: setting a new schedule almost
// always means "here's my new week," not "add one more window."
labProvidersRouter.put(
  '/:id/working-hours',
  requireAuth('doctor', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    if (!(await isAuthorizedForLab(req, provider))) {
      return res.status(403).json({ success: false, error: 'not_authorized_for_this_lab' });
    }
    const { windows } = req.body;
    if (!Array.isArray(windows)) {
      return res.status(400).json({ success: false, error: 'windows[] is required, each {day_of_week, open_time, close_time}' });
    }
    for (const w of windows) {
      if (w.day_of_week < 0 || w.day_of_week > 6) {
        return res.status(400).json({ success: false, error: 'day_of_week must be 0-6' });
      }
      if (!/^\d{2}:\d{2}$/.test(w.open_time) || !/^\d{2}:\d{2}$/.test(w.close_time)) {
        return res.status(400).json({ success: false, error: 'open_time and close_time must be in HH:MM format' });
      }
    }
    await prisma.$transaction([
      prisma.labWorkingHours.deleteMany({ where: { labProviderId: req.params.id } }),
      prisma.labWorkingHours.createMany({
        data: windows.map((w: any) => ({
          labProviderId: req.params.id,
          dayOfWeek: w.day_of_week,
          openTime: w.open_time,
          closeTime: w.close_time
        }))
      })
    ]);
    const workingHours = await prisma.labWorkingHours.findMany({
      where: { labProviderId: req.params.id },
      orderBy: { dayOfWeek: 'asc' }
    });
    res.json({ success: true, working_hours: workingHours });
  })
);

labProvidersRouter.post(
  '/:id/services',
  requireAuth('doctor', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    if (!(await isAuthorizedForLab(req, provider))) {
      return res.status(403).json({ success: false, error: 'not_authorized_for_this_lab' });
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

labProvidersRouter.patch(
  '/:id/services/:serviceId',
  requireAuth('doctor', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    if (!(await isAuthorizedForLab(req, provider))) {
      return res.status(403).json({ success: false, error: 'not_authorized_for_this_lab' });
    }
    const existing = await prisma.labService.findUnique({ where: { id: req.params.serviceId } });
    if (!existing || existing.labProviderId !== provider.id) {
      return res.status(404).json({ success: false, error: 'lab_service_not_found' });
    }
    const { test_name, base_price, test_code, turnaround_hours, is_active } = req.body;
    const service = await prisma.labService.update({
      where: { id: req.params.serviceId },
      data: {
        ...(test_name !== undefined ? { testName: test_name } : {}),
        ...(base_price !== undefined ? { basePrice: base_price } : {}),
        ...(test_code !== undefined ? { testCode: test_code } : {}),
        ...(turnaround_hours !== undefined ? { turnaroundHours: turnaround_hours } : {}),
        ...(is_active !== undefined ? { isActive: is_active } : {})
      }
    });
    res.json({ success: true, lab_service: service });
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
      include: { services: { where: { isActive: true } }, workingHours: { orderBy: { dayOfWeek: 'asc' } } }
    });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    res.json({ success: true, lab_provider: provider });
  })
);

// ── KYC ──────────────────────────────────────────────────────────

labProvidersRouter.post(
  '/:id/kyc/upload-url',
  requireAuth('doctor', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    if (!(await isAuthorizedForLab(req, provider))) {
      return res.status(403).json({ success: false, error: 'not_authorized_for_this_lab' });
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
  requireAuth('doctor', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    if (!(await isAuthorizedForLab(req, provider))) {
      return res.status(403).json({ success: false, error: 'not_authorized_for_this_lab' });
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
  requireAuth('doctor', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    if (!(await isAuthorizedForLab(req, provider))) {
      return res.status(403).json({ success: false, error: 'not_authorized_for_this_lab' });
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
  requireAuth('doctor', 'lab_staff'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    if (!(await isAuthorizedForLab(req, provider))) {
      return res.status(403).json({ success: false, error: 'not_authorized_for_this_lab' });
    }
    const staff = await prisma.labStaff.findMany({ where: { labProviderId: provider.id } });
    res.json({ success: true, staff: staff.map(({ passwordHash: _omit, ...s }: any) => s) });
  })
);
