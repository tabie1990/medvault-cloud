import { Router } from 'express';
import { TERMS_VERSION, TERMS_TEXT_EN, TERMS_TEXT_FR } from '../services/legal.service.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export const legalRouter = Router();

legalRouter.get(
  '/terms',
  asyncHandler(async (req, res) => {
    const lang = req.query.lang === 'fr' ? 'fr' : 'en';
    res.json({
      success: true,
      version: TERMS_VERSION,
      text: lang === 'fr' ? TERMS_TEXT_FR : TERMS_TEXT_EN
    });
  })
);
