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
  asyncHandler(async (_req, res) => {
    const doctors = await prisma.doctor.findMany({
      where: { verificationStatus: 'pending', kycSubmittedAt: { not: null } },
      orderBy: { kycSubmittedAt: 'asc' }
    });
    const labProviders = await prisma.labProvider.findMany({
      where: { verificationStatus: 'pending', kycSubmittedAt: { not: null } },
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
    const errors = await prisma.errorLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    res.json({ success: true, errors });
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
