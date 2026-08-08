-- CreateTable
CREATE TABLE "GuardianLink" (
    "id" UUID NOT NULL,
    "guardianPatientId" TEXT NOT NULL,
    "childPatientId" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuardianLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthMeasurement" (
    "id" UUID NOT NULL,
    "childPatientId" TEXT NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "weightKg" DECIMAL(65,30),
    "heightCm" DECIMAL(65,30),
    "headCircumferenceCm" DECIMAL(65,30),
    "muacCm" DECIMAL(65,30),
    "recordedByDoctorId" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrowthMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaccinationScheduleItem" (
    "id" UUID NOT NULL,
    "vaccineName" TEXT NOT NULL,
    "dueAtDays" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "VaccinationScheduleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaccinationRecord" (
    "id" UUID NOT NULL,
    "childPatientId" TEXT NOT NULL,
    "scheduleItemId" UUID NOT NULL,
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'due',
    "administeredAt" TIMESTAMP(3),
    "batchNumber" TEXT,
    "administeredBy" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VaccinationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NeonatalRecord" (
    "id" UUID NOT NULL,
    "childPatientId" TEXT NOT NULL,
    "motherPatientId" TEXT,
    "birthWeightKg" DECIMAL(65,30),
    "birthLengthCm" DECIMAL(65,30),
    "headCircumferenceCm" DECIMAL(65,30),
    "apgar1Min" INTEGER,
    "apgar5Min" INTEGER,
    "modeOfDelivery" TEXT,
    "gestationalAgeWeeks" INTEGER,
    "complications" TEXT,
    "vitaminKGiven" BOOLEAN NOT NULL DEFAULT false,
    "hepBBirthDoseGiven" BOOLEAN NOT NULL DEFAULT false,
    "newbornScreeningResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NeonatalRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevelopmentalMilestone" (
    "id" UUID NOT NULL,
    "childPatientId" TEXT NOT NULL,
    "milestoneName" TEXT NOT NULL,
    "achievedAt" TIMESTAMP(3),
    "ageAtAssessmentMonths" INTEGER,
    "concernFlagged" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevelopmentalMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuardianLink_childPatientId_idx" ON "GuardianLink"("childPatientId");

-- CreateIndex
CREATE UNIQUE INDEX "GuardianLink_guardianPatientId_childPatientId_key" ON "GuardianLink"("guardianPatientId", "childPatientId");

-- CreateIndex
CREATE INDEX "GrowthMeasurement_childPatientId_idx" ON "GrowthMeasurement"("childPatientId");

-- CreateIndex
CREATE INDEX "VaccinationRecord_childPatientId_idx" ON "VaccinationRecord"("childPatientId");

-- CreateIndex
CREATE INDEX "VaccinationRecord_status_scheduledDate_idx" ON "VaccinationRecord"("status", "scheduledDate");

-- CreateIndex
CREATE UNIQUE INDEX "NeonatalRecord_childPatientId_key" ON "NeonatalRecord"("childPatientId");

-- CreateIndex
CREATE INDEX "DevelopmentalMilestone_childPatientId_idx" ON "DevelopmentalMilestone"("childPatientId");

-- AddForeignKey
ALTER TABLE "VaccinationRecord" ADD CONSTRAINT "VaccinationRecord_scheduleItemId_fkey" FOREIGN KEY ("scheduleItemId") REFERENCES "VaccinationScheduleItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
