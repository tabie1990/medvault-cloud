-- AlterEnum
ALTER TYPE "OtpPurpose" ADD VALUE 'password_reset';

-- DropForeignKey
ALTER TABLE "PaymentSplit" DROP CONSTRAINT "PaymentSplit_appointmentId_fkey";

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "hospitalDoctorRosterId" UUID,
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Doctor" ADD COLUMN     "address" TEXT,
ADD COLUMN     "consultationTypes" JSONB DEFAULT '[]',
ADD COLUMN     "dob" TIMESTAMP(3),
ADD COLUMN     "teleconsultSlotMinutes" INTEGER NOT NULL DEFAULT 15;

-- AlterTable
ALTER TABLE "ErrorLog" ADD COLUMN     "resolvedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Hospital" ADD COLUMN     "appointmentSlotMinutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "flatBookingFee" DECIMAL(65,30),
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "LabOrder" ADD COLUMN     "paymentAmount" DECIMAL(65,30),
ADD COLUMN     "paymentPhone" TEXT,
ADD COLUMN     "paymentReference" TEXT,
DROP COLUMN "paymentStatus",
ADD COLUMN     "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'unpaid';

-- AlterTable
ALTER TABLE "LabProvider" ADD COLUMN     "email" TEXT,
ADD COLUMN     "momoNetwork" TEXT,
ADD COLUMN     "momoNumber" TEXT;

-- AlterTable
ALTER TABLE "PaymentSplit" ADD COLUMN     "labOrderId" UUID,
ALTER COLUMN "appointmentId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "HospitalDoctorRoster" (
    "id" UUID NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "specialty" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospitalDoctorRoster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospitalDoctorWorkingHours" (
    "id" UUID NOT NULL,
    "rosterId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalDoctorWorkingHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospitalService" (
    "id" UUID NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorAvailability" (
    "id" UUID NOT NULL,
    "doctorId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoctorAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabWorkingHours" (
    "id" UUID NOT NULL,
    "labProviderId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "openTime" TEXT NOT NULL,
    "closeTime" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabWorkingHours_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "HospitalDoctorRoster" ADD CONSTRAINT "HospitalDoctorRoster_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("hospitalId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalDoctorWorkingHours" ADD CONSTRAINT "HospitalDoctorWorkingHours_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "HospitalDoctorRoster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalService" ADD CONSTRAINT "HospitalService_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("hospitalId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_hospitalDoctorRosterId_fkey" FOREIGN KEY ("hospitalDoctorRosterId") REFERENCES "HospitalDoctorRoster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorAvailability" ADD CONSTRAINT "DoctorAvailability_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabWorkingHours" ADD CONSTRAINT "LabWorkingHours_labProviderId_fkey" FOREIGN KEY ("labProviderId") REFERENCES "LabProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSplit" ADD CONSTRAINT "PaymentSplit_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSplit" ADD CONSTRAINT "PaymentSplit_labOrderId_fkey" FOREIGN KEY ("labOrderId") REFERENCES "LabOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

