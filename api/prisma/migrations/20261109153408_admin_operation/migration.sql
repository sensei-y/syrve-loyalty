-- CreateEnum
CREATE TYPE "OpType" AS ENUM ('TOPUP', 'CHARGEOFF');

-- CreateEnum
CREATE TYPE "OpStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Admin" (
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operation" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "syrveCustomerId" TEXT NOT NULL,
    "type" "OpType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "OpStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Admin_login_key" ON "Admin"("login");

-- CreateIndex
CREATE UNIQUE INDEX "Operation_idempotencyKey_key" ON "Operation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Operation_syrveCustomerId_createdAt_idx" ON "Operation"("syrveCustomerId", "createdAt");

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

