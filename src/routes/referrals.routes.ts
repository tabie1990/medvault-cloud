import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { generateReferralCode } from '../services/id.service.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { env } from '../config/env.js';

export const referralsRouter = Router();

// Deliberately no auth required — "doctors or patients or anyone" can
// request a code, including someone with no MedVAULT account at all.
// The referrer's identity is captured directly on the code itself
// (see ReferralCode in schema.prisma) rather than requiring a login.
referralsRouter.post(
  '/generate-code',
  asyncHandler(async (req, res) => {
    const { referrer_name, referrer_phone, referrer_momo_number, referrer_momo_network } = req.body;
    if (!referrer_name || !referrer_phone) {
      return res.status(400).json({ success: false, error: 'referrer_name and referrer_phone are required' });
    }
    const code = generateReferralCode();
    const referralCode = await prisma.referralCode.create({
      data: {
        code,
        referrerName: referrer_name,
        referrerPhone: referrer_phone,
        referrerMomoNumber: referrer_momo_number,
        referrerMomoNetwork: referrer_momo_network
      }
    });
    res.status(201).json({
      success: true,
      code: referralCode.code,
      share_link: `${env.webAppUrl}/doctor-register?ref=${referralCode.code}`
    });
  })
);
