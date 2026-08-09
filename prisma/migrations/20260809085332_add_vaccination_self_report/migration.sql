-- AlterTable
ALTER TABLE "VaccinationRecord" ADD COLUMN     "proofImageKey" TEXT,
ADD COLUMN     "proofSubmittedAt" TIMESTAMP(3),
ADD COLUMN     "reportedByGuardianAt" TIMESTAMP(3),
ADD COLUMN     "reportedDate" TIMESTAMP(3);
