-- AlterTable
ALTER TABLE "Guest" ALTER COLUMN "lastRevision" DROP NOT NULL,
ALTER COLUMN "lastRevision" DROP DEFAULT;

-- CreateTable
CREATE TABLE "NotifiedTransaction" (
    "syrveTransactionId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotifiedTransaction_pkey" PRIMARY KEY ("syrveTransactionId")
);


-- Базовая точка ещё не взята: прежнее значение 0 означало то же самое.
UPDATE "Guest" SET "lastRevision" = NULL WHERE "lastRevision" = 0;
