-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Notification" (
    "syrveTransactionId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "sum" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2),
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("syrveTransactionId")
);

-- CreateIndex
CREATE INDEX "Notification_status_idx" ON "Notification"("status");

-- Уже отправленные уведомления переносим как SENT, чтобы не отправить их повторно.
-- Сумма в старой таблице не хранилась — 0 (строка служит только для дедупа).
INSERT INTO "Notification" ("syrveTransactionId", "guestId", "sum", "status", "attempts", "createdAt", "sentAt")
SELECT "syrveTransactionId", "guestId", 0, 'SENT', 1, "createdAt", "createdAt"
FROM "NotifiedTransaction";

-- DropTable
DROP TABLE "NotifiedTransaction";
