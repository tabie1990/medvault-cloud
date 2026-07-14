/*
  Warnings:

  - A unique constraint covering the columns `[phone]` on the table `Doctor` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[email]` on the table `Doctor` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[email]` on the table `LabStaff` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[phone]` on the table `LabStaff` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('unpaid', 'pending', 'paid');

-- CreateEnum
CREATE TYPE "PaymentSplitStatus" AS ENUM ('pending', 'completed', 'failed');

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "paymentAmount" DECIMAL(65,30),
ADD COLUMN     "paymentPhone" TEXT,
ADD COLUMN     "paymentReference" TEXT,
ADD COLUMN     "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'unpaid';

-- AlterTable
ALTER TABLE "Doctor" ADD COLUMN     "momoNetwork" TEXT,
ADD COLUMN     "momoNumber" TEXT,
ADD COLUMN     "teleconsultFee" DECIMAL(65,30) DEFAULT 0;

-- AlterTable
ALTER TABLE "Hospital" ADD COLUMN     "hospitalMomoNetwork" TEXT,
ADD COLUMN     "hospitalMomoNumber" TEXT;

-- CreateTable
CREATE TABLE "PaymentSplit" (
    "id" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "totalAmount" DECIMAL(65,30) NOT NULL,
    "platformFeePct" DECIMAL(65,30) NOT NULL DEFAULT 10,
    "platformAmount" DECIMAL(65,30) NOT NULL,
    "providerAmount" DECIMAL(65,30) NOT NULL,
    "medvaultMomo" TEXT,
    "providerMomo" TEXT,
    "providerNetwork" TEXT,
    "patientPaymentRef" TEXT,
    "platformPayoutRef" TEXT,
    "providerPayoutRef" TEXT,
    "status" "PaymentSplitStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentSplit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prescription" (
    "id" UUID NOT NULL,
    "prescriptionRef" TEXT NOT NULL,
    "appointmentId" UUID NOT NULL,
    "globalPatientId" TEXT,
    "doctorId" UUID NOT NULL,
    "symptoms" TEXT,
    "diagnosis" TEXT,
    "notes" TEXT,
    "items" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'issued',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prescription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Prescription_prescriptionRef_key" ON "Prescription"("prescriptionRef");

-- CreateIndex
CREATE UNIQUE INDEX "Doctor_phone_key" ON "Doctor"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Doctor_email_key" ON "Doctor"("email");

-- CreateIndex
CREATE UNIQUE INDEX "LabStaff_email_key" ON "LabStaff"("email");

-- CreateIndex
CREATE UNIQUE INDEX "LabStaff_phone_key" ON "LabStaff"("phone");

-- AddForeignKey
ALTER TABLE "PaymentSplit" ADD CONSTRAINT "PaymentSplit_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_globalPatientId_fkey" FOREIGN KEY ("globalPatientId") REFERENCES "GlobalPatient"("globalPatientId") ON DELETE SET NULL ON UPDATE CASCADE;
