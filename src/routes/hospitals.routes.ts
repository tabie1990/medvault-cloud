import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../db/prisma.js';
import { encryptSecret } from '../services/crypto.service.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export const hospitalsRouter = Router();

hospitalsRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { hospital_id, hospital_code, name, country, region, city } = req.body;
    if (!hospital_id || !hospital_code || !name) {
      return res.status(400).json({ success: false, error: 'hospital_id, hospital_code, and name are required' });
    }
    const hospital = await prisma.hospital.create({
      data: { hospitalId: hospital_id, hospitalCode: hospital_code, name, country, region, city }
    });
    await prisma.auditLog.create({
      data: { action: 'hospital.registered', entityType: 'hospital', entityId: hospital.hospitalId, metadata: req.body }
    });
    res.status(201).json({ success: true, hospital });
  })
);

hospitalsRouter.post(
  '/installations/activate',
  asyncHandler(async (req, res) => {
    const { hospital_id, installation_id, device_label, license_key, hmac_secret } = req.body;
    if (!hospital_id || !installation_id || !license_key || !hmac_secret) {
      return res.status(400).json({
        success: false,
        error: 'hospital_id, installation_id, license_key, and hmac_secret are required'
      });
    }
    const licenseKeyHash = await bcrypt.hash(license_key, 12);
    const hmacSecretEncrypted = encryptSecret(hmac_secret);
    const installation = await prisma.hospitalInstallation.create({
      data: {
        hospitalId: hospital_id,
        installationId: installation_id,
        deviceLabel: device_label,
        licenseKeyHash,
        hmacSecretEncrypted
      }
    });
    await prisma.auditLog.create({
      data: { action: 'installation.activated', entityType: 'installation', entityId: installation.installationId }
    });
    // Note: hmac_secret is never echoed back — the offline HMS already has its
    // own copy locally; it only ever needs to sign requests with it, not
    // resend it.
    res.status(201).json({
      success: true,
      installation_id: installation.installationId,
      status: installation.status
    });
  })
);

// Public — for the patient web portal and WhatsApp agent to browse
// hospitals and see a hospital's roster/services before booking an
// in-person appointment.
hospitalsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { city } = req.query;
    const hospitals = await prisma.hospital.findMany({
      where: { status: 'active', ...(city ? { city: String(city) } : {}) },
      take: 50
    });
    res.json({ success: true, hospitals });
  })
);

hospitalsRouter.get(
  '/:hospitalId/doctors',
  asyncHandler(async (req, res) => {
    const roster = await prisma.hospitalDoctorRoster.findMany({
      where: { hospitalId: req.params.hospitalId },
      include: { workingHours: { orderBy: { dayOfWeek: 'asc' } } }
    });
    res.json({ success: true, doctors: roster });
  })
);

hospitalsRouter.get(
  '/:hospitalId/services',
  asyncHandler(async (req, res) => {
    const services = await prisma.hospitalService.findMany({ where: { hospitalId: req.params.hospitalId } });
    res.json({ success: true, services });
  })
);
