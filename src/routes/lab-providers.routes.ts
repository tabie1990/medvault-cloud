import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { generateRef } from '../services/id.service.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';

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

labProvidersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { city, service_type } = req.query;
    const providers = await prisma.labProvider.findMany({
      where: {
        ...(city ? { city: String(city) } : {}),
        ...(service_type ? { serviceType: service_type as any } : {})
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
