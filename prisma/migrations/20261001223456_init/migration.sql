-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "kyc_status" AS ENUM ('NOT_STARTED', 'PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "kyc_document_type" AS ENUM ('NATIONAL_ID', 'PASSPORT', 'DRIVERS_LICENSE', 'VOTERS_CARD', 'UTILITY_BILL', 'SELFIE');

-- CreateEnum
CREATE TYPE "kyc_document_status" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ledger_account_type" AS ENUM ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "wallet_status" AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "transaction_type" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'PAYMENT', 'REFUND', 'FEE', 'REVERSAL');

-- CreateEnum
CREATE TYPE "transaction_status" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVERSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "entry_direction" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "hold_status" AS ENUM ('ACTIVE', 'SETTLED', 'RELEASED');

-- CreateEnum
CREATE TYPE "recipient_lookup_type" AS ENUM ('HANDLE', 'ACCOUNT_NUMBER');

-- CreateEnum
CREATE TYPE "payment_direction" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "webhook_status" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "idempotency_status" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "beneficiary_type" AS ENUM ('FUNDRA_WALLET', 'BANK_ACCOUNT');

-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('EMAIL', 'SMS', 'PUSH', 'IN_APP');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('USER', 'ADMIN', 'SYSTEM');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(3),
    "phone" TEXT NOT NULL,
    "phone_verified_at" TIMESTAMPTZ(3),
    "handle" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "user_status" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "deactivated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_by_user_id" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "device_id" TEXT,
    "device_name" TEXT,
    "user_agent" TEXT,
    "ip_address" INET,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "session_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "replaced_by_id" UUID,
    "used_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_profiles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "tier" SMALLINT NOT NULL DEFAULT 0,
    "status" "kyc_status" NOT NULL DEFAULT 'NOT_STARTED',
    "requested_tier" SMALLINT,
    "date_of_birth" DATE,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" CHAR(2),
    "postal_code" TEXT,
    "bvn_encrypted" BYTEA,
    "nin_encrypted" BYTEA,
    "bvn_hmac" CHAR(64),
    "nin_hmac" CHAR(64),
    "provider" TEXT,
    "provider_reference" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "reviewed_at" TIMESTAMPTZ(3),
    "reviewed_by_user_id" UUID,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_documents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "kyc_profile_id" UUID NOT NULL,
    "type" "kyc_document_type" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "status" "kyc_document_status" NOT NULL DEFAULT 'PENDING',
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMPTZ(3),

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tier_limits" (
    "tier" SMALLINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "per_transaction_limit" BIGINT NOT NULL,
    "daily_outflow_limit" BIGINT NOT NULL,
    "max_balance" BIGINT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tier_limits_pkey" PRIMARY KEY ("tier","currency")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "type" "ledger_account_type" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "account_number" CHAR(10) NOT NULL,
    "ledger_account_id" UUID NOT NULL,
    "status" "wallet_status" NOT NULL DEFAULT 'ACTIVE',
    "ledger_balance" BIGINT NOT NULL DEFAULT 0,
    "available_balance" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reference" TEXT NOT NULL,
    "type" "transaction_type" NOT NULL,
    "status" "transaction_status" NOT NULL DEFAULT 'PENDING',
    "currency" CHAR(3) NOT NULL,
    "amount" BIGINT NOT NULL,
    "fee" BIGINT NOT NULL DEFAULT 0,
    "source_wallet_id" UUID,
    "destination_wallet_id" UUID,
    "initiated_by_user_id" UUID,
    "reversal_of_id" UUID,
    "description" VARCHAR(140),
    "failure_reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "transaction_id" UUID NOT NULL,
    "ledger_account_id" UUID NOT NULL,
    "direction" "entry_direction" NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "balance_after" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holds" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "wallet_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "hold_status" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "transaction_id" UUID NOT NULL,
    "recipient_lookup" "recipient_lookup_type" NOT NULL,
    "recipient_lookup_value" TEXT NOT NULL,
    "beneficiary_id" UUID,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("transaction_id")
);

-- CreateTable
CREATE TABLE "fee_rules" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "transaction_type" "transaction_type" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "flat_fee" BIGINT NOT NULL DEFAULT 0,
    "percentage_bps" INTEGER NOT NULL DEFAULT 0,
    "min_fee" BIGINT,
    "max_fee" BIGINT,
    "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_providers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "transaction_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "direction" "payment_direction" NOT NULL,
    "provider_reference" TEXT,
    "provider_status" TEXT,
    "checkout_url" TEXT,
    "bank_code" TEXT,
    "bank_account_number" TEXT,
    "bank_account_name" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("transaction_id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "webhook_status" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "transaction_id" UUID,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "idempotency_status" NOT NULL DEFAULT 'IN_PROGRESS',
    "response_status" INTEGER,
    "response_body" JSONB,
    "transaction_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beneficiaries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "type" "beneficiary_type" NOT NULL,
    "recipient_wallet_id" UUID,
    "bank_code" TEXT,
    "bank_account_number" TEXT,
    "bank_account_name" TEXT,
    "nickname" TEXT,
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "beneficiaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "read_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "actor_type" "actor_type" NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "ip_address" INET,
    "user_agent" TEXT,
    "request_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_handle_key" ON "users"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_active_idx" ON "sessions"("user_id") WHERE (revoked_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replaced_by_id_key" ON "refresh_tokens"("replaced_by_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_profiles_user_id_key" ON "kyc_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_profiles_bvn_hmac_key" ON "kyc_profiles"("bvn_hmac");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_profiles_nin_hmac_key" ON "kyc_profiles"("nin_hmac");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_documents_storage_key_key" ON "kyc_documents"("storage_key");

-- CreateIndex
CREATE INDEX "kyc_documents_kyc_profile_id_idx" ON "kyc_documents"("kyc_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_code_key" ON "ledger_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_id_currency_key" ON "ledger_accounts"("id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_account_number_key" ON "wallets"("account_number");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_ledger_account_id_key" ON "wallets"("ledger_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_currency_key" ON "wallets"("user_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_reference_key" ON "transactions"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_reversal_of_id_key" ON "transactions"("reversal_of_id");

-- CreateIndex
CREATE INDEX "transactions_source_wallet_id_created_at_id_idx" ON "transactions"("source_wallet_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "transactions_destination_wallet_id_created_at_id_idx" ON "transactions"("destination_wallet_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "transactions_in_flight_idx" ON "transactions"("status", "created_at") WHERE (status IN ('PENDING', 'PROCESSING'));

-- CreateIndex
CREATE UNIQUE INDEX "transactions_id_currency_key" ON "transactions"("id", "currency");

-- CreateIndex
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries"("transaction_id");

-- CreateIndex
CREATE INDEX "ledger_entries_ledger_account_id_created_at_id_idx" ON "ledger_entries"("ledger_account_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "holds_transaction_id_key" ON "holds"("transaction_id");

-- CreateIndex
CREATE INDEX "holds_wallet_id_active_idx" ON "holds"("wallet_id") WHERE (status = 'ACTIVE');

-- CreateIndex
CREATE INDEX "transfers_beneficiary_id_idx" ON "transfers"("beneficiary_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_rules_one_active_idx" ON "fee_rules"("transaction_type", "currency") WHERE (is_active);

-- CreateIndex
CREATE UNIQUE INDEX "payment_providers_code_key" ON "payment_providers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_id_provider_reference_key" ON "payments"("provider_id", "provider_reference");

-- CreateIndex
CREATE INDEX "webhook_events_transaction_id_idx" ON "webhook_events"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_id_event_id_key" ON "webhook_events"("provider_id", "event_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_transaction_id_idx" ON "idempotency_keys"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_key_key" ON "idempotency_keys"("user_id", "key");

-- CreateIndex
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events"("created_at") WHERE (published_at IS NULL);

-- CreateIndex
CREATE INDEX "beneficiaries_recipient_wallet_id_idx" ON "beneficiaries"("recipient_wallet_id");

-- CreateIndex
CREATE UNIQUE INDEX "beneficiaries_wallet_unique_idx" ON "beneficiaries"("user_id", "recipient_wallet_id") WHERE (type = 'FUNDRA_WALLET');

-- CreateIndex
CREATE UNIQUE INDEX "beneficiaries_bank_unique_idx" ON "beneficiaries"("user_id", "bank_code", "bank_account_number") WHERE (type = 'BANK_ACCOUNT');

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_created_at_idx" ON "audit_logs"("resource_type", "resource_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_profiles" ADD CONSTRAINT "kyc_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_profiles" ADD CONSTRAINT "kyc_profiles_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_kyc_profile_id_fkey" FOREIGN KEY ("kyc_profile_id") REFERENCES "kyc_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_ledger_account_id_currency_fkey" FOREIGN KEY ("ledger_account_id", "currency") REFERENCES "ledger_accounts"("id", "currency") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_wallet_id_fkey" FOREIGN KEY ("source_wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_destination_wallet_id_fkey" FOREIGN KEY ("destination_wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_initiated_by_user_id_fkey" FOREIGN KEY ("initiated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_currency_fkey" FOREIGN KEY ("transaction_id", "currency") REFERENCES "transactions"("id", "currency") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_ledger_account_id_currency_fkey" FOREIGN KEY ("ledger_account_id", "currency") REFERENCES "ledger_accounts"("id", "currency") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holds" ADD CONSTRAINT "holds_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holds" ADD CONSTRAINT "holds_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beneficiaries" ADD CONSTRAINT "beneficiaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beneficiaries" ADD CONSTRAINT "beneficiaries_recipient_wallet_id_fkey" FOREIGN KEY ("recipient_wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written: CHECK constraints (not expressible in schema.prisma).
-- Rationale for each rule: docs/DATABASE.md. The application validates first,
-- so these only fire if a bug lets bad data through.
-- ═══════════════════════════════════════════════════════════════════════════

-- Identity
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_lowercase_chk" CHECK (email = lower(email)),
  ADD CONSTRAINT "users_phone_e164_chk" CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT "users_handle_format_chk" CHECK (handle ~ '^[a-z0-9_]{3,20}$'),
  ADD CONSTRAINT "users_failed_login_count_chk" CHECK (failed_login_count >= 0);

ALTER TABLE "permissions"
  ADD CONSTRAINT "permissions_key_format_chk" CHECK (key ~ '^[a-z_]+:[a-z_]+$');

-- KYC
ALTER TABLE "kyc_profiles"
  ADD CONSTRAINT "kyc_profiles_tier_chk" CHECK (tier BETWEEN 0 AND 3),
  ADD CONSTRAINT "kyc_profiles_requested_tier_chk"
    CHECK (requested_tier IS NULL OR (requested_tier > tier AND requested_tier <= 3)),
  ADD CONSTRAINT "kyc_profiles_country_chk" CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');

ALTER TABLE "kyc_documents"
  ADD CONSTRAINT "kyc_documents_size_chk" CHECK (size_bytes > 0),
  ADD CONSTRAINT "kyc_documents_mime_chk"
    CHECK (mime_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  ADD CONSTRAINT "kyc_documents_sha256_chk" CHECK (sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE "tier_limits"
  ADD CONSTRAINT "tier_limits_tier_chk" CHECK (tier BETWEEN 1 AND 3),
  ADD CONSTRAINT "tier_limits_currency_chk" CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "tier_limits_positive_chk"
    CHECK (per_transaction_limit > 0 AND daily_outflow_limit > 0
           AND (max_balance IS NULL OR max_balance > 0)),
  ADD CONSTRAINT "tier_limits_per_tx_within_daily_chk"
    CHECK (per_transaction_limit <= daily_outflow_limit);

-- Money
ALTER TABLE "ledger_accounts"
  ADD CONSTRAINT "ledger_accounts_currency_chk" CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_currency_chk" CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "wallets_account_number_chk" CHECK (account_number ~ '^[0-9]{10}$'),
  -- Last line of defence against overdraft and over-reservation.
  ADD CONSTRAINT "wallets_ledger_balance_chk" CHECK (ledger_balance >= 0),
  ADD CONSTRAINT "wallets_available_balance_chk"
    CHECK (available_balance >= 0 AND available_balance <= ledger_balance);

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_reference_chk"
    CHECK (reference ~ '^FND-TRX-[0-9]{8}-[0-9A-F]{6}$'),
  ADD CONSTRAINT "transactions_currency_chk" CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "transactions_amount_chk" CHECK (amount > 0),
  ADD CONSTRAINT "transactions_fee_chk" CHECK (fee >= 0),
  ADD CONSTRAINT "transactions_has_wallet_chk"
    CHECK (source_wallet_id IS NOT NULL OR destination_wallet_id IS NOT NULL),
  ADD CONSTRAINT "transactions_distinct_wallets_chk"
    CHECK (source_wallet_id IS DISTINCT FROM destination_wallet_id),
  ADD CONSTRAINT "transactions_completed_at_chk"
    CHECK (status NOT IN ('COMPLETED', 'REVERSED') OR completed_at IS NOT NULL),
  ADD CONSTRAINT "transactions_not_self_reversal_chk"
    CHECK (reversal_of_id IS DISTINCT FROM id);

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_chk" CHECK (amount > 0);

ALTER TABLE "holds"
  ADD CONSTRAINT "holds_amount_chk" CHECK (amount > 0),
  ADD CONSTRAINT "holds_resolved_at_chk" CHECK ((status = 'ACTIVE') = (resolved_at IS NULL));

ALTER TABLE "fee_rules"
  ADD CONSTRAINT "fee_rules_currency_chk" CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "fee_rules_non_negative_chk"
    CHECK (flat_fee >= 0 AND (min_fee IS NULL OR min_fee >= 0) AND (max_fee IS NULL OR max_fee >= 0)),
  ADD CONSTRAINT "fee_rules_bps_chk" CHECK (percentage_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT "fee_rules_min_max_chk"
    CHECK (min_fee IS NULL OR max_fee IS NULL OR min_fee <= max_fee);

-- Integration
ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_key_length_chk" CHECK (length(key) BETWEEN 8 AND 255),
  ADD CONSTRAINT "idempotency_keys_request_hash_chk" CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "idempotency_keys_completed_chk"
    CHECK (status <> 'COMPLETED' OR response_status IS NOT NULL);

ALTER TABLE "webhook_events"
  ADD CONSTRAINT "webhook_events_attempts_chk" CHECK (attempts >= 0);

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_attempts_chk" CHECK (attempts >= 0);

-- Platform
ALTER TABLE "beneficiaries"
  ADD CONSTRAINT "beneficiaries_fields_match_type_chk" CHECK (
    (type = 'FUNDRA_WALLET' AND recipient_wallet_id IS NOT NULL
       AND bank_code IS NULL AND bank_account_number IS NULL)
    OR
    (type = 'BANK_ACCOUNT' AND recipient_wallet_id IS NULL
       AND bank_code IS NOT NULL AND bank_account_number IS NOT NULL
       AND bank_account_name IS NOT NULL)
  );
