-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "syncedToHospitalAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LabOrder" ADD COLUMN     "lastSyncedStatus" "LabOrderStatus";
