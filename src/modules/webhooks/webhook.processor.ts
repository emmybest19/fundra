// Processes stored webhook events: rebuilds the provider's event from the stored payload and
// hands it to the payments module (docs/ARCHITECTURE.md §8.6). Safe to run any number of
// times for the same event: the payment services lock the transaction row and answer
// ALREADY_APPLIED to news they already applied.
import type { PrismaClient, WebhookStatus } from '../../generated/prisma/client.ts';
import type { DepositService } from '../payments/deposit.service.ts';
import type { OutboundPaymentService } from '../payments/outbound-payment.service.ts';
import type { PaymentEventOutcome } from '../payments/payment-review.ts';
import type { PaymentProvider } from '../payments/providers/payment-provider.ts';
import type { ProcessedWebhook } from './webhook.types.ts';

/** After this many attempts an event is left FAILED for a person (Stage 19 admin view). */
export const MAX_WEBHOOK_ATTEMPTS = 10;

export class WebhookProcessor {
  readonly #db: PrismaClient;
  readonly #provider: PaymentProvider;
  readonly #deposits: DepositService;
  readonly #outbound: OutboundPaymentService;

  constructor(
    db: PrismaClient,
    provider: PaymentProvider,
    deposits: DepositService,
    outbound: OutboundPaymentService,
  ) {
    this.#db = db;
    this.#provider = provider;
    this.#deposits = deposits;
    this.#outbound = outbound;
  }

  /**
   * Applies one stored event. Never throws for a processing failure: the event is marked
   * FAILED with the error and its attempt counted, to be retried (by a provider redelivery
   * now, by the process-webhook job from Stage 16).
   */
  async process(webhookEventId: string): Promise<ProcessedWebhook> {
    const row = await this.#db.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (row === null) throw new Error(`Webhook event ${webhookEventId} not found`);
    if (row.status === 'PROCESSED' || row.status === 'IGNORED') {
      return { webhookEventId, status: row.status, skipped: true };
    }
    if (row.attempts >= MAX_WEBHOOK_ATTEMPTS) {
      return { webhookEventId, status: row.status, skipped: true };
    }

    try {
      // The stored payload is what the provider signed, parsed; the parser ignores key order.
      const event = this.#provider.parseWebhook(Buffer.from(JSON.stringify(row.payload), 'utf8'));
      if (event === null)
        return await this.#finish(row.id, 'FAILED', 'Stored payload no longer parses');
      if (event.kind === 'OTHER') return await this.#finish(row.id, 'IGNORED', null);

      const outcome =
        event.kind === 'DEPOSIT'
          ? await this.#deposits.applyEvent(event)
          : event.kind === 'REFUND'
            ? await this.#outbound.applyRefund(event)
            : await this.#outbound.applyEvent(event);
      return await this.#record(row.id, outcome);
    } catch (err) {
      return this.#finish(row.id, 'FAILED', errorMessage(err));
    }
  }

  /**
   * Processes events still waiting (RECEIVED) or failed with attempts left, oldest first.
   * The process-webhook job (Stage 16) runs this on a schedule.
   */
  async processPending(limit = 50): Promise<ProcessedWebhook[]> {
    const pending = await this.#db.webhookEvent.findMany({
      where: { status: { in: ['RECEIVED', 'FAILED'] }, attempts: { lt: MAX_WEBHOOK_ATTEMPTS } },
      orderBy: { receivedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    const results: ProcessedWebhook[] = [];
    for (const { id } of pending) results.push(await this.process(id));
    return results;
  }

  /** What the payment services decided, as the event's status. */
  #record(id: string, outcome: PaymentEventOutcome): Promise<ProcessedWebhook> {
    switch (outcome.outcome) {
      case 'COMPLETED':
      case 'FAILED':
      case 'ALREADY_APPLIED':
        return this.#finish(id, 'PROCESSED', null, outcome.transactionId, outcome.outcome);
      case 'REVIEW':
        // Processed: a person now owns it (payments.metadata.review, audit log).
        return this.#finish(
          id,
          'PROCESSED',
          `Held for review: ${outcome.reason}`,
          outcome.transactionId,
          outcome.outcome,
        );
      case 'UNMATCHED':
        // Maybe too early (our side not committed yet): FAILED, so it is tried again.
        return this.#finish(id, 'FAILED', 'No payment matches this provider reference');
    }
  }

  async #finish(
    id: string,
    status: WebhookStatus,
    lastError: string | null,
    transactionId?: string,
    outcome?: PaymentEventOutcome['outcome'],
  ): Promise<ProcessedWebhook> {
    await this.#db.webhookEvent.update({
      where: { id },
      data: {
        status,
        lastError,
        attempts: { increment: 1 },
        ...(transactionId === undefined ? {} : { transactionId }),
        ...(status === 'PROCESSED' || status === 'IGNORED' ? { processedAt: new Date() } : {}),
      },
    });
    return {
      webhookEventId: id,
      status,
      skipped: false,
      ...(outcome === undefined ? {} : { outcome }),
      ...(lastError === null ? {} : { lastError }),
    };
  }
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
