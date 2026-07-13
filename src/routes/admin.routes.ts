import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { getDownloadUrl } from '../services/storage.service.js';

export const adminRouter = Router();

/**
 * Minimal scope for the July 30 pilot, deliberately — see ROADMAP.md.
 * KYC approve/reject is the one piece of "admin" that can't be optional:
 * without it nobody gets verified, and verified status gates who can
 * accept a teleconsult or appear as a lab. The fuller monitoring dashboard
 * (revenue, error feed, stale-sync alerts) is explicitly deferred.
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
