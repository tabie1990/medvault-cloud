import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { getDownloadUrl } from '../services/storage.service.js';

export const adminRouter = Router();

/**
 * KYC approve/reject is the one piece of "admin" that can't be optional:
 * without it nobody gets verified, and verified status gates who can
 * accept a teleconsult or appear as a lab. The fuller monitoring
 * dashboard (revenue, error feed, stale-sync alerts) below was initially
 * deferred past the pilot's core scope, then built once that core scope
 * was actually complete.
 */

adminRouter.get(
  '/kyc/pending',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    // Defaults to pending-only, preserving the original behavior — pass
    // ?status=all to also see already-approved/rejected doctors and labs
    // alongside those still awaiting review.
    const status = (req.query.status as string) ?? 'pending';
    const statusFilter = status === 'all' ? {} : { verificationStatus: status as any };
    const doctors = await prisma.doctor.findMany({
      where: { ...statusFilter, kycSubmittedAt: { not: null } },
      orderBy: { kycSubmittedAt: 'asc' }
    });
    const labProviders = await prisma.labProvider.findMany({
      where: { ...statusFilter, kycSubmittedAt: { not: null } },
      orderBy: { kycSubmittedAt: 'asc' }
    });
    res.json({
      success: true,
      doctors: doctors.map(({ passwordHash: _omit, ...d }: any) => d),
      lab_providers: labProviders
    });
  })
);

// Short-lived signed URLs to actually view a submitted document —
// documents are never publicly readable, so the review screen needs this
// rather than a plain link.
adminRouter.get(
  '/kyc/doctors/:id/document-url',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    const { field } = req.query; // 'national_id' | 'medical_license' | 'selfie'
    const doctor = await prisma.doctor.findUnique({ where: { id: req.params.id } });
    if (!doctor) return res.status(404).json({ success: false, error: 'doctor_not_found' });
    const keyMap: Record<string, string | null> = {
      national_id: doctor.nationalIdDocumentKey,
      medical_license: doctor.medicalLicenseDocumentKey,
      selfie: doctor.selfieKey
    };
    const key = keyMap[String(field)];
    if (!key) return res.status(404).json({ success: false, error: 'document_not_found' });
    const url = await getDownloadUrl(key);
    res.json({ success: true, url });
  })
);

adminRouter.get(
  '/kyc/lab-providers/:id/document-url',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    const { field } = req.query; // 'business_registration' | 'lab_accreditation' | 'owner_id'
    const provider = await prisma.labProvider.findUnique({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ success: false, error: 'lab_provider_not_found' });
    const keyMap: Record<string, string | null> = {
      business_registration: provider.businessRegistrationDocumentKey,
      lab_accreditation: provider.labAccreditationDocumentKey,
      owner_id: provider.ownerIdDocumentKey
    };
    const key = keyMap[String(field)];
    if (!key) return res.status(404).json({ success: false, error: 'document_not_found' });
    const url = await getDownloadUrl(key);
    res.json({ success: true, url });
  })
);

adminRouter.post(
  '/kyc/doctors/:id/decision',
  requireAuth('admin'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { approve, reason } = req.body;
    if (typeof approve !== 'boolean') {
      return res.status(400).json({ success: false, error: 'approve (boolean) is required' });
    }
    const doctor = await prisma.doctor.update({
      where: { id: req.params.id },
      data: {
        verificationStatus: approve ? 'verified' : 'rejected',
        kycReviewedAt: new Date(),
        kycReviewedBy: req.user!.sub,
        kycRejectionReason: approve ? null : reason ?? 'Not specified'
      }
    });
    res.json({ success: true, verification_status: doctor.verificationStatus });
  })
);

adminRouter.post(
  '/kyc/lab-providers/:id/decision',
  requireAuth('admin'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { approve, reason } = req.body;
    if (typeof approve !== 'boolean') {
      return res.status(400).json({ success: false, error: 'approve (boolean) is required' });
    }
    const provider = await prisma.labProvider.update({
      where: { id: req.params.id },
      data: {
        verificationStatus: approve ? 'verified' : 'rejected',
        kycReviewedAt: new Date(),
        kycReviewedBy: req.user!.sub,
        kycRejectionReason: approve ? null : reason ?? 'Not specified'
      }
    });
    res.json({ success: true, verification_status: provider.verificationStatus });
  })
);

/**
 * Fuller monitoring dashboard — revenue, error feed, stale-sync alerts.
 * Deliberately deferred past the initial pilot scope (see the comment at
 * the top of this file); built once the pilot's core scope was complete
 * and this became the next real priority.
 */

adminRouter.get(
  '/revenue',
  requireAuth('admin'),
  asyncHandler(async (_req, res) => {
    const [platformTotal, appointmentGross, labOrderGross, recentSplits] = await Promise.all([
      prisma.paymentSplit.aggregate({ where: { status: 'completed' }, _sum: { platformAmount: true } }),
      prisma.appointment.aggregate({ where: { paymentStatus: 'paid' }, _sum: { paymentAmount: true } }),
      prisma.labOrder.aggregate({ where: { paymentStatus: 'paid' }, _sum: { paymentAmount: true } }),
      prisma.paymentSplit.findMany({
        where: { status: 'completed' },
        orderBy: { completedAt: 'desc' },
        take: 20,
        select: { id: true, totalAmount: true, platformAmount: true, providerAmount: true, completedAt: true, appointmentId: true, labOrderId: true }
      })
    ]);
    res.json({
      success: true,
      platform_revenue_total: platformTotal._sum.platformAmount ?? 0,
      appointment_gross_total: appointmentGross._sum.paymentAmount ?? 0,
      lab_order_gross_total: labOrderGross._sum.paymentAmount ?? 0,
      recent_payouts: recentSplits
    });
  })
);

adminRouter.get(
  '/errors',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    // Hides resolved entries by default so the feed reflects what's
    // actually still outstanding — pass ?include_resolved=true to see
    // everything, including what's already been dealt with.
    const includeResolved = req.query.include_resolved === 'true';
    const errors = await prisma.errorLog.findMany({
      where: includeResolved ? {} : { resolvedAt: null },
      orderBy: { createdAt: 'desc' },
      take: limit
    });
    res.json({ success: true, errors });
  })
);

adminRouter.post(
  '/errors/:id/resolve',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    const entry = await prisma.errorLog.update({ where: { id: req.params.id }, data: { resolvedAt: new Date() } });
    res.json({ success: true, error: entry });
  })
);

adminRouter.get(
  '/stale-syncs',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    // Default: flag any active hospital installation that hasn't been
    // seen in over an hour. Configurable via ?hours=N for a looser or
    // tighter threshold without a code change.
    const hours = Math.min(Number(req.query.hours ?? 1), 168);
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const stale = await prisma.hospitalInstallation.findMany({
      where: {
        status: 'active',
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }]
      },
      include: { hospital: { select: { name: true, hospitalId: true } } }
    });
    res.json({ success: true, threshold_hours: hours, stale_installations: stale });
  })
);

/**
 * Manual hospital roster/services management — Block 7, piece 2.
 * Deliberately admin-entered rather than pushed from the HMS: avoids
 * touching that codebase at all, at the honest cost of needing manual
 * updates if a hospital's roster changes. Right-sized for the pilot's
 * hospital count; worth automating later if that count grows enough
 * that manual maintenance becomes a real burden. This is a SEPARATE set
 * of endpoints from the HMS's own unauthenticated POST /hospitals/register
 * — that one stays exactly as-is, untouched, since the HMS calls it
 * before it has any token to authenticate with.
 */

adminRouter.post(
  '/hospitals',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    const { hospital_id, hospital_code, name, country, region, city, latitude, longitude } = req.body;
    if (!hospital_id || !hospital_code || !name) {
      return res.status(400).json({ success: false, error: 'hospital_id, hospital_code, and name are required' });
    }
    const hospital = await prisma.hospital.create({
      data: {
        hospitalId: hospital_id,
        hospitalCode: hospital_code,
        name,
        country,
        region,
        city,
        latitude: latitude !== undefined ? Number(latitude) : undefined,
        longitude: longitude !== undefined ? Number(longitude) : undefined
      }
    });
    res.status(201).json({ success: true, hospital });
  })
);

// Set/update an existing hospital's coordinates, flat booking fee, and
// payout MoMo details — needed for any hospital registered before these
// existed, or created without them.
adminRouter.patch(
  '/hospitals/:hospitalId',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    const { latitude, longitude, city, region, flat_booking_fee, hospital_momo_number, hospital_momo_network, appointment_slot_minutes } = req.body;
    const hospital = await prisma.hospital.update({
      where: { hospitalId: req.params.hospitalId },
      data: {
        ...(latitude !== undefined ? { latitude: Number(latitude) } : {}),
        ...(longitude !== undefined ? { longitude: Number(longitude) } : {}),
        ...(city !== undefined ? { city } : {}),
        ...(region !== undefined ? { region } : {}),
        ...(flat_booking_fee !== undefined ? { flatBookingFee: Number(flat_booking_fee) } : {}),
        ...(hospital_momo_number !== undefined ? { hospitalMomoNumber: hospital_momo_number } : {}),
        ...(hospital_momo_network !== undefined ? { hospitalMomoNetwork: hospital_momo_network } : {}),
        ...(appointment_slot_minutes !== undefined ? { appointmentSlotMinutes: Number(appointment_slot_minutes) } : {})
      }
    });
    res.json({ success: true, hospital });
  })
);

adminRouter.get(
  '/hospitals',
  requireAuth('admin'),
  asyncHandler(async (_req, res) => {
    const hospitals = await prisma.hospital.findMany({
      include: { doctorRoster: { include: { workingHours: true } }, services: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, hospitals });
  })
);

adminRouter.post(
  '/hospitals/:hospitalId/services',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });
    const service = await prisma.hospitalService.create({ data: { hospitalId: req.params.hospitalId, name } });
    res.status(201).json({ success: true, service });
  })
);

adminRouter.delete(
  '/hospitals/:hospitalId/services/:id',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    await prisma.hospitalService.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  })
);

adminRouter.post(
  '/hospitals/:hospitalId/doctors',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    const { full_name, specialty } = req.body;
    if (!full_name) return res.status(400).json({ success: false, error: 'full_name is required' });
    const doctor = await prisma.hospitalDoctorRoster.create({
      data: { hospitalId: req.params.hospitalId, fullName: full_name, specialty }
    });
    res.status(201).json({ success: true, doctor });
  })
);

adminRouter.delete(
  '/hospitals/:hospitalId/doctors/:id',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    await prisma.hospitalDoctorWorkingHours.deleteMany({ where: { rosterId: req.params.id } });
    await prisma.hospitalDoctorRoster.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  })
);

adminRouter.put(
  '/hospitals/:hospitalId/doctors/:id/working-hours',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    const { windows } = req.body;
    if (!Array.isArray(windows)) {
      return res.status(400).json({ success: false, error: 'windows[] is required, each {day_of_week, start_time, end_time}' });
    }
    for (const w of windows) {
      if (w.day_of_week < 0 || w.day_of_week > 6) {
        return res.status(400).json({ success: false, error: 'day_of_week must be 0-6' });
      }
      if (!/^\d{2}:\d{2}$/.test(w.start_time) || !/^\d{2}:\d{2}$/.test(w.end_time)) {
        return res.status(400).json({ success: false, error: 'start_time and end_time must be in HH:MM format' });
      }
    }
    await prisma.$transaction([
      prisma.hospitalDoctorWorkingHours.deleteMany({ where: { rosterId: req.params.id } }),
      prisma.hospitalDoctorWorkingHours.createMany({
        data: windows.map((w: any) => ({ rosterId: req.params.id, dayOfWeek: w.day_of_week, startTime: w.start_time, endTime: w.end_time }))
      })
    ]);
    const workingHours = await prisma.hospitalDoctorWorkingHours.findMany({
      where: { rosterId: req.params.id },
      orderBy: { dayOfWeek: 'asc' }
    });
    res.json({ success: true, working_hours: workingHours });
  })
);
