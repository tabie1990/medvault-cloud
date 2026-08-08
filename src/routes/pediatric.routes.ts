import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { generateGlobalPatientId } from '../services/id.service.js';
import { createPendingVaccinationRecords } from '../services/pediatric.service.js';

export const pediatricRouter = Router();

// Confirms the authenticated guardian actually has a GuardianLink to this
// child before letting them see or touch anything — same pattern as the
// existing patient-timeline endpoint's ownership check, just for a
// one-to-many relationship instead of a direct match.
async function assertGuardianOfChild(req: AuthedRequest, childPatientId: string): Promise<boolean> {
  if (req.user!.role !== 'patient') return true; // doctor/admin — checked separately per-route
  const link = await prisma.guardianLink.findFirst({
    where: { guardianPatientId: req.user!.sub, childPatientId }
  });
  return !!link;
}

// ── Registering a child + linking a guardian ────────────────────────

pediatricRouter.post(
  '/children',
  requireAuth('patient'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { full_name, dob, sex, relationship } = req.body;
    if (!full_name || !dob || !relationship) {
      return res.status(400).json({ success: false, error: 'full_name, dob, and relationship are required' });
    }

    const childGlobalPatientId = await generateGlobalPatientId();
    const child = await prisma.globalPatient.create({
      data: { globalPatientId: childGlobalPatientId, fullName: full_name, dob: new Date(dob), sex: sex ?? null }
    });

    await prisma.guardianLink.create({
      data: { guardianPatientId: req.user!.sub, childPatientId: child.globalPatientId, relationship }
    });

    // Auto-create the full set of pending EPI doses for this child right
    // away, based on their real DOB — see pediatric.service.ts for why
    // this happens once at registration rather than being computed
    // on-the-fly every time someone asks.
    await createPendingVaccinationRecords(child.globalPatientId, new Date(dob));

    res.status(201).json({ success: true, child });
  })
);

pediatricRouter.post(
  '/children/:childPatientId/guardians',
  requireAuth('patient'),
  asyncHandler(async (req: AuthedRequest, res) => {
    // Deliberately not ownership-gated the same way other routes are —
    // a second guardian (the other parent, a relative) linking
    // themselves to an existing child is exactly the "one child can have
    // multiple guardians" case from the original requirement, and the
    // first guardian isn't necessarily present to approve it.
    const { relationship } = req.body;
    if (!relationship) return res.status(400).json({ success: false, error: 'relationship is required' });

    const child = await prisma.globalPatient.findUnique({ where: { globalPatientId: req.params.childPatientId } });
    if (!child) return res.status(404).json({ success: false, error: 'child_not_found' });

    const link = await prisma.guardianLink.upsert({
      where: { guardianPatientId_childPatientId: { guardianPatientId: req.user!.sub, childPatientId: child.globalPatientId } },
      update: { relationship },
      create: { guardianPatientId: req.user!.sub, childPatientId: child.globalPatientId, relationship }
    });
    res.status(201).json({ success: true, link });
  })
);

pediatricRouter.get(
  '/children',
  requireAuth('patient'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const links = await prisma.guardianLink.findMany({ where: { guardianPatientId: req.user!.sub } });
    const childIds = links.map((l: any) => l.childPatientId);
    const children = await prisma.globalPatient.findMany({ where: { globalPatientId: { in: childIds } } });
    const relationshipByChild = new Map<string, string>(links.map((l: any) => [l.childPatientId, l.relationship]));
    res.json({
      success: true,
      children: children.map((c: any) => ({ ...c, relationship: relationshipByChild.get(c.globalPatientId) }))
    });
  })
);

// ── A child's full record ────────────────────────────────────────────

pediatricRouter.get(
  '/children/:childPatientId',
  requireAuth('patient', 'doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { childPatientId } = req.params;
    if (!(await assertGuardianOfChild(req, childPatientId))) {
      return res.status(403).json({ success: false, error: 'not_a_guardian_of_this_child' });
    }

    const [child, guardianLinks, growthMeasurements, vaccinationRecords, neonatalRecord, milestones] = await Promise.all([
      prisma.globalPatient.findUnique({ where: { globalPatientId: childPatientId } }),
      prisma.guardianLink.findMany({ where: { childPatientId } }),
      prisma.growthMeasurement.findMany({ where: { childPatientId }, orderBy: { measuredAt: 'desc' } }),
      prisma.vaccinationRecord.findMany({ where: { childPatientId }, include: { scheduleItem: true }, orderBy: { scheduledDate: 'asc' } }),
      prisma.neonatalRecord.findUnique({ where: { childPatientId } }),
      prisma.developmentalMilestone.findMany({ where: { childPatientId }, orderBy: { createdAt: 'desc' } })
    ]);

    if (!child) return res.status(404).json({ success: false, error: 'child_not_found' });

    res.json({
      success: true,
      child,
      guardians: guardianLinks,
      growth_measurements: growthMeasurements,
      vaccinations: vaccinationRecords,
      neonatal_record: neonatalRecord,
      milestones
    });
  })
);

// ── Growth measurements — doctor-recorded, during a visit ───────────

pediatricRouter.post(
  '/children/:childPatientId/growth-measurements',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { weight_kg, height_cm, head_circumference_cm, muac_cm, notes } = req.body;
    const measurement = await prisma.growthMeasurement.create({
      data: {
        childPatientId: req.params.childPatientId,
        weightKg: weight_kg ?? null,
        heightCm: height_cm ?? null,
        headCircumferenceCm: head_circumference_cm ?? null,
        muacCm: muac_cm ?? null,
        recordedByDoctorId: req.user!.sub,
        notes: notes ?? null
      }
    });
    res.status(201).json({ success: true, measurement });
  })
);

// ── Vaccinations ──────────────────────────────────────────────────────

pediatricRouter.get(
  '/children/:childPatientId/vaccinations',
  requireAuth('patient', 'doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { childPatientId } = req.params;
    if (!(await assertGuardianOfChild(req, childPatientId))) {
      return res.status(403).json({ success: false, error: 'not_a_guardian_of_this_child' });
    }
    const records = await prisma.vaccinationRecord.findMany({
      where: { childPatientId },
      include: { scheduleItem: true },
      orderBy: { scheduledDate: 'asc' }
    });
    res.json({ success: true, vaccinations: records });
  })
);

pediatricRouter.post(
  '/vaccination-records/:id/administer',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { batch_number, administered_by, administered_at } = req.body;
    const record = await prisma.vaccinationRecord.update({
      where: { id: req.params.id },
      data: {
        status: 'administered',
        administeredAt: administered_at ? new Date(administered_at) : new Date(),
        batchNumber: batch_number ?? null,
        administeredBy: administered_by ?? null
      }
    });
    res.json({ success: true, record });
  })
);

// ── Neonatal / birth record ───────────────────────────────────────────

pediatricRouter.post(
  '/children/:childPatientId/neonatal-record',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const {
      birth_weight_kg, birth_length_cm, head_circumference_cm, apgar_1min, apgar_5min,
      mode_of_delivery, gestational_age_weeks, complications, vitamin_k_given,
      hep_b_birth_dose_given, newborn_screening_result, mother_patient_id
    } = req.body;

    const record = await prisma.neonatalRecord.upsert({
      where: { childPatientId: req.params.childPatientId },
      update: {
        birthWeightKg: birth_weight_kg ?? undefined,
        birthLengthCm: birth_length_cm ?? undefined,
        headCircumferenceCm: head_circumference_cm ?? undefined,
        apgar1Min: apgar_1min ?? undefined,
        apgar5Min: apgar_5min ?? undefined,
        modeOfDelivery: mode_of_delivery ?? undefined,
        gestationalAgeWeeks: gestational_age_weeks ?? undefined,
        complications: complications ?? undefined,
        vitaminKGiven: vitamin_k_given ?? undefined,
        hepBBirthDoseGiven: hep_b_birth_dose_given ?? undefined,
        newbornScreeningResult: newborn_screening_result ?? undefined,
        motherPatientId: mother_patient_id ?? undefined
      },
      create: {
        childPatientId: req.params.childPatientId,
        birthWeightKg: birth_weight_kg ?? null,
        birthLengthCm: birth_length_cm ?? null,
        headCircumferenceCm: head_circumference_cm ?? null,
        apgar1Min: apgar_1min ?? null,
        apgar5Min: apgar_5min ?? null,
        modeOfDelivery: mode_of_delivery ?? null,
        gestationalAgeWeeks: gestational_age_weeks ?? null,
        complications: complications ?? null,
        vitaminKGiven: vitamin_k_given ?? false,
        hepBBirthDoseGiven: hep_b_birth_dose_given ?? false,
        newbornScreeningResult: newborn_screening_result ?? null,
        motherPatientId: mother_patient_id ?? null
      }
    });
    res.status(201).json({ success: true, neonatal_record: record });
  })
);

// ── Developmental milestones ──────────────────────────────────────────

pediatricRouter.post(
  '/children/:childPatientId/milestones',
  requireAuth('doctor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { milestone_name, achieved_at, age_at_assessment_months, concern_flagged, notes } = req.body;
    if (!milestone_name) return res.status(400).json({ success: false, error: 'milestone_name is required' });

    const milestone = await prisma.developmentalMilestone.create({
      data: {
        childPatientId: req.params.childPatientId,
        milestoneName: milestone_name,
        achievedAt: achieved_at ? new Date(achieved_at) : null,
        ageAtAssessmentMonths: age_at_assessment_months ?? null,
        concernFlagged: concern_flagged ?? false,
        notes: notes ?? null
      }
    });
    res.status(201).json({ success: true, milestone });
  })
);
