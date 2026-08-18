/*
  Warnings:

  - The `paymentStatus` column on the `LabOrder` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- DropForeignKey
ALTER TABLE "PaymentSplit" DROP CONSTRAINT "PaymentSplit_appointmentId_fkey";

-- AlterTable
ALTER TABLE "LabOrder" ADD COLUMN     "paymentAmount" DECIMAL(65,30),
ADD COLUMN     "paymentPhone" TEXT,
ADD COLUMN     "paymentReference" TEXT,
DROP COLUMN "paymentStatus",
ADD COLUMN     "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'unpaid';

-- AlterTable
ALTER TABLE "LabProvider" ADD COLUMN     "momoNetwork" TEXT,
ADD COLUMN     "momoNumber" TEXT;

-- AlterTable
ALTER TABLE "PaymentSplit" ADD COLUMN     "labOrderId" UUID,
ALTER COLUMN "appointmentId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "PaymentSplit" ADD CONSTRAINT "PaymentSplit_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSplit" ADD CONSTRAINT "PaymentSplit_labOrderId_fkey" FOREIGN KEY ("labOrderId") REFERENCES "LabOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
