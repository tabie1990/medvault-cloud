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
ALTER TABLE "LabWorkingHours" ADD CONSTRAINT "LabWorkingHours_labProviderId_fkey" FOREIGN KEY ("labProviderId") REFERENCES "LabProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
