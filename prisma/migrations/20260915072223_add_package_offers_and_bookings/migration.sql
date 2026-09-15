-- CreateTable
CREATE TABLE "PackageOffer" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "includedItems" JSONB NOT NULL,
    "basePrice" DECIMAL(65,30) NOT NULL,
    "homeServiceFee" DECIMAL(65,30) NOT NULL DEFAULT 4500,
    "maxChildAge" INTEGER NOT NULL DEFAULT 17,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackageOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageBooking" (
    "id" UUID NOT NULL,
    "bookingRef" TEXT NOT NULL,
    "offerId" UUID NOT NULL,
    "guardianName" TEXT,
    "guardianPhone" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "childrenCount" INTEGER NOT NULL,
    "childrenAges" JSONB NOT NULL,
    "homeService" BOOLEAN NOT NULL DEFAULT false,
    "preferredDate" TIMESTAMP(3),
    "preferredTimeRange" TEXT,
    "totalPrice" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_payment',
    "paymentStatus" TEXT NOT NULL DEFAULT 'unpaid',
    "paymentReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackageBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PackageBooking_bookingRef_key" ON "PackageBooking"("bookingRef");

-- CreateIndex
CREATE INDEX "PackageBooking_bookingRef_idx" ON "PackageBooking"("bookingRef");

-- CreateIndex
CREATE INDEX "PackageBooking_status_idx" ON "PackageBooking"("status");

-- AddForeignKey
ALTER TABLE "PackageBooking" ADD CONSTRAINT "PackageBooking_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "PackageOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

