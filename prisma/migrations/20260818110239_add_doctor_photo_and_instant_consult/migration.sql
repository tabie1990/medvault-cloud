-- CreateEnum
CREATE TYPE "TeleconsultRequestStatus" AS ENUM ('pending', 'claimed', 'expired', 'cancelled');

-- AlterTable
ALTER TABLE "Doctor" ADD COLUMN     "acceptingInstantConsults" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "profilePhotoKey" TEXT;

-- CreateTable
CREATE TABLE "TeleconsultRequest" (
    "id" UUID NOT NULL,
    "requestRef" TEXT NOT NULL,
    "globalPatientId" TEXT,
    "waPhoneNumber" TEXT NOT NULL,
    "specialty" TEXT,
    "notes" TEXT,
    "consultationFee" DECIMAL(65,30),
    "status" "TeleconsultRequestStatus" NOT NULL DEFAULT 'pending',
    "dispatchedToDoctorIds" JSONB NOT NULL DEFAULT '[]',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedByDoctorId" UUID,
    "claimedAt" TIMESTAMP(3),
    "appointmentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeleconsultRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeleconsultRequest_requestRef_key" ON "TeleconsultRequest"("requestRef");

-- CreateIndex
CREATE UNIQUE INDEX "TeleconsultRequest_appointmentId_key" ON "TeleconsultRequest"("appointmentId");

-- CreateIndex
CREATE INDEX "TeleconsultRequest_status_expiresAt_idx" ON "TeleconsultRequest"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "TeleconsultRequest" ADD CONSTRAINT "TeleconsultRequest_globalPatientId_fkey" FOREIGN KEY ("globalPatientId") REFERENCES "GlobalPatient"("globalPatientId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeleconsultRequest" ADD CONSTRAINT "TeleconsultRequest_claimedByDoctorId_fkey" FOREIGN KEY ("claimedByDoctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeleconsultRequest" ADD CONSTRAINT "TeleconsultRequest_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
