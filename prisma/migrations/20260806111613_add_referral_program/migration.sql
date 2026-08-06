-- CreateTable
CREATE TABLE "ReferralCode" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "referrerName" TEXT NOT NULL,
    "referrerPhone" TEXT NOT NULL,
    "referrerMomoNumber" TEXT,
    "referrerMomoNetwork" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorReferral" (
    "id" UUID NOT NULL,
    "referralCodeId" UUID NOT NULL,
    "referredDoctorId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rewardAmount" DECIMAL(65,30) NOT NULL DEFAULT 1000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "DoctorReferral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "DoctorReferral_referredDoctorId_key" ON "DoctorReferral"("referredDoctorId");

-- AddForeignKey
ALTER TABLE "DoctorReferral" ADD CONSTRAINT "DoctorReferral_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "ReferralCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
