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
