-- CreateEnum
CREATE TYPE "statement_status" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "statements" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "statement_status" NOT NULL DEFAULT 'PENDING',
    "storage_key" TEXT,
    "opening_balance" BIGINT,
    "closing_balance" BIGINT,
    "entry_count" INTEGER,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "statements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "statements_user_id_created_at_idx" ON "statements"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "statements_wallet_id_idx" ON "statements"("wallet_id");

-- AddForeignKey
ALTER TABLE "statements" ADD CONSTRAINT "statements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statements" ADD CONSTRAINT "statements_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written: CHECK constraints (not expressible in schema.prisma).
ALTER TABLE "statements"
  ADD CONSTRAINT "statements_period_chk" CHECK (period_end >= period_start),
  ADD CONSTRAINT "statements_ready_chk" CHECK (
    status <> 'READY' OR (storage_key IS NOT NULL AND opening_balance IS NOT NULL
      AND closing_balance IS NOT NULL AND entry_count IS NOT NULL AND completed_at IS NOT NULL)
  ),
  ADD CONSTRAINT "statements_failed_chk" CHECK (status <> 'FAILED' OR failure_reason IS NOT NULL);
