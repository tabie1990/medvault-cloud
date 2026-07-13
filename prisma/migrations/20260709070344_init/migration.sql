-- CreateEnum
CREATE TYPE "HospitalStatus" AS ENUM ('active', 'suspended', 'disabled');

-- CreateEnum
CREATE TYPE "InstallationStatus" AS ENUM ('active', 'suspended', 'revoked');

-- CreateEnum
CREATE TYPE "EventDirection" AS ENUM ('hospital_to_cloud', 'cloud_to_hospital');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('pending', 'queued', 'processed', 'failed', 'ignored');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('pending', 'confirmed', 'cancelled', 'completed', 'rejected');

-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('hospital', 'independent', 'lab', 'pharmacy');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('pending', 'verified', 'rejected', 'suspended');

-- CreateEnum
CREATE TYPE "LabServiceType" AS ENUM ('home_visit', 'on_site', 'both');

-- CreateEnum
CREATE TYPE "LabOrderStatus" AS ENUM ('requested', 'scheduled', 'sample_collected', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "TelemedicineStatus" AS ENUM ('scheduled', 'ongoing', 'completed', 'cancelled', 'no_show');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('whatsapp', 'push', 'sms', 'email');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('pending', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('patient_login', 'doctor_login');

-- CreateTable
CREATE TABLE "Hospital" (
    "id" UUID NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "hospitalCode" VARCHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'Cameroon',
    "region" TEXT,
    "city" TEXT,
    "status" "HospitalStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hospital_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospitalInstallation" (
    "id" UUID NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "installationId" UUID NOT NULL,
    "deviceLabel" TEXT,
    "licenseKeyHash" TEXT NOT NULL,
    "hmacSecretEncrypted" TEXT NOT NULL,
    "status" "InstallationStatus" NOT NULL DEFAULT 'active',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalPatient" (
    "id" UUID NOT NULL,
    "globalPatientId" TEXT NOT NULL,
    "primaryPhone" TEXT,
    "email" TEXT,
    "fullName" TEXT,
    "dob" TIMESTAMP(3),
    "sex" TEXT,
    "country" TEXT NOT NULL DEFAULT 'Cameroon',
    "identityConfidence" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalPatient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientIdentityMap" (
    "id" UUID NOT NULL,
    "globalPatientId" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "installationId" UUID NOT NULL,
    "hospitalPatientUuid" UUID NOT NULL,
    "localPatientId" TEXT NOT NULL,
    "hospitalCode" VARCHAR(3) NOT NULL,
    "matchStatus" TEXT NOT NULL DEFAULT 'confirmed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientIdentityMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncEvent" (
    "id" UUID NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "installationId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "localPatientId" TEXT,
    "globalPatientId" TEXT,
    "payload" JSONB NOT NULL,
    "direction" "EventDirection" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "SyncEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" UUID NOT NULL,
    "appointmentRef" TEXT NOT NULL,
    "globalPatientId" TEXT,
    "hospitalId" TEXT,
    "doctorId" UUID,
    "appointmentType" TEXT NOT NULL,
    "requestedDate" TIMESTAMP(3),
    "requestedTime" TEXT,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'pending',
    "source" TEXT NOT NULL,
    "channel" TEXT,
    "notes" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Doctor" (
    "id" UUID NOT NULL,
    "doctorRef" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "passwordHash" TEXT,
    "specialty" TEXT,
    "licenseNumber" TEXT,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'pending',
    "providerType" "ProviderType" NOT NULL DEFAULT 'independent',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Doctor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorType" TEXT,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "ipAddress" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabProvider" (
    "id" UUID NOT NULL,
    "providerRef" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerDoctorId" UUID,
    "hospitalId" TEXT,
    "serviceType" "LabServiceType" NOT NULL DEFAULT 'on_site',
    "homeServiceFee" DECIMAL(65,30) DEFAULT 0,
    "city" TEXT,
    "region" TEXT,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabService" (
    "id" UUID NOT NULL,
    "labProviderId" UUID NOT NULL,
    "testName" TEXT NOT NULL,
    "testCode" TEXT,
    "basePrice" DECIMAL(65,30) NOT NULL,
    "turnaroundHours" INTEGER DEFAULT 24,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabOrder" (
    "id" UUID NOT NULL,
    "orderRef" TEXT NOT NULL,
    "globalPatientId" TEXT,
    "hospitalId" TEXT,
    "referringDoctorId" UUID,
    "referralAppointmentId" UUID,
    "labProviderId" UUID NOT NULL,
    "serviceType" "LabServiceType" NOT NULL,
    "homeAddress" TEXT,
    "scheduledDate" TIMESTAMP(3),
    "scheduledTime" TEXT,
    "status" "LabOrderStatus" NOT NULL DEFAULT 'requested',
    "totalCost" DECIMAL(65,30),
    "paymentStatus" TEXT DEFAULT 'unpaid',
    "resultPayload" JSONB,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabOrderItem" (
    "id" UUID NOT NULL,
    "labOrderId" UUID NOT NULL,
    "labServiceId" UUID NOT NULL,
    "priceAtOrder" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "LabOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemedicineSession" (
    "id" UUID NOT NULL,
    "sessionRef" TEXT NOT NULL,
    "appointmentId" UUID NOT NULL,
    "doctorId" UUID,
    "globalPatientId" TEXT,
    "roomProvider" TEXT NOT NULL DEFAULT 'daily.co',
    "roomUrl" TEXT,
    "status" "TelemedicineStatus" NOT NULL DEFAULT 'scheduled',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemedicineSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "recipientType" TEXT NOT NULL,
    "recipientRef" TEXT NOT NULL,
    "templateType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppContact" (
    "id" UUID NOT NULL,
    "waPhoneNumber" TEXT NOT NULL,
    "globalPatientId" TEXT,
    "conversationState" JSONB,
    "lastInteractionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" UUID NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerRef" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpCode" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Hospital_hospitalId_key" ON "Hospital"("hospitalId");

-- CreateIndex
CREATE UNIQUE INDEX "Hospital_hospitalCode_key" ON "Hospital"("hospitalCode");

-- CreateIndex
CREATE UNIQUE INDEX "HospitalInstallation_installationId_key" ON "HospitalInstallation"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalPatient_globalPatientId_key" ON "GlobalPatient"("globalPatientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientIdentityMap_hospitalId_localPatientId_key" ON "PatientIdentityMap"("hospitalId", "localPatientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientIdentityMap_hospitalId_hospitalPatientUuid_key" ON "PatientIdentityMap"("hospitalId", "hospitalPatientUuid");

-- CreateIndex
CREATE INDEX "SyncEvent_hospitalId_status_idx" ON "SyncEvent"("hospitalId", "status");

-- CreateIndex
CREATE INDEX "SyncEvent_globalPatientId_idx" ON "SyncEvent"("globalPatientId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncEvent_hospitalId_installationId_eventId_key" ON "SyncEvent"("hospitalId", "installationId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_appointmentRef_key" ON "Appointment"("appointmentRef");

-- CreateIndex
CREATE UNIQUE INDEX "Doctor_doctorRef_key" ON "Doctor"("doctorRef");

-- CreateIndex
CREATE UNIQUE INDEX "LabProvider_providerRef_key" ON "LabProvider"("providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "LabOrder_orderRef_key" ON "LabOrder"("orderRef");

-- CreateIndex
CREATE INDEX "LabOrder_globalPatientId_idx" ON "LabOrder"("globalPatientId");

-- CreateIndex
CREATE INDEX "LabOrder_labProviderId_status_idx" ON "LabOrder"("labProviderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TelemedicineSession_sessionRef_key" ON "TelemedicineSession"("sessionRef");

-- CreateIndex
CREATE UNIQUE INDEX "TelemedicineSession_appointmentId_key" ON "TelemedicineSession"("appointmentId");

-- CreateIndex
CREATE INDEX "Notification_status_idx" ON "Notification"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppContact_waPhoneNumber_key" ON "WhatsAppContact"("waPhoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_ownerType_ownerRef_pushToken_key" ON "DeviceToken"("ownerType", "ownerRef", "pushToken");

-- CreateIndex
CREATE INDEX "OtpCode_phone_purpose_idx" ON "OtpCode"("phone", "purpose");

-- AddForeignKey
ALTER TABLE "HospitalInstallation" ADD CONSTRAINT "HospitalInstallation_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("hospitalId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientIdentityMap" ADD CONSTRAINT "PatientIdentityMap_globalPatientId_fkey" FOREIGN KEY ("globalPatientId") REFERENCES "GlobalPatient"("globalPatientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientIdentityMap" ADD CONSTRAINT "PatientIdentityMap_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("hospitalId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientIdentityMap" ADD CONSTRAINT "PatientIdentityMap_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "HospitalInstallation"("installationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_globalPatientId_fkey" FOREIGN KEY ("globalPatientId") REFERENCES "GlobalPatient"("globalPatientId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("hospitalId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabProvider" ADD CONSTRAINT "LabProvider_ownerDoctorId_fkey" FOREIGN KEY ("ownerDoctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabProvider" ADD CONSTRAINT "LabProvider_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("hospitalId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabService" ADD CONSTRAINT "LabService_labProviderId_fkey" FOREIGN KEY ("labProviderId") REFERENCES "LabProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_globalPatientId_fkey" FOREIGN KEY ("globalPatientId") REFERENCES "GlobalPatient"("globalPatientId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("hospitalId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_referringDoctorId_fkey" FOREIGN KEY ("referringDoctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_referralAppointmentId_fkey" FOREIGN KEY ("referralAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_labProviderId_fkey" FOREIGN KEY ("labProviderId") REFERENCES "LabProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabOrderItem" ADD CONSTRAINT "LabOrderItem_labOrderId_fkey" FOREIGN KEY ("labOrderId") REFERENCES "LabOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabOrderItem" ADD CONSTRAINT "LabOrderItem_labServiceId_fkey" FOREIGN KEY ("labServiceId") REFERENCES "LabService"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemedicineSession" ADD CONSTRAINT "TelemedicineSession_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemedicineSession" ADD CONSTRAINT "TelemedicineSession_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemedicineSession" ADD CONSTRAINT "TelemedicineSession_globalPatientId_fkey" FOREIGN KEY ("globalPatientId") REFERENCES "GlobalPatient"("globalPatientId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppContact" ADD CONSTRAINT "WhatsAppContact_globalPatientId_fkey" FOREIGN KEY ("globalPatientId") REFERENCES "GlobalPatient"("globalPatientId") ON DELETE SET NULL ON UPDATE CASCADE;
