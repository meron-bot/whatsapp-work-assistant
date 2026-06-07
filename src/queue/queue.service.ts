import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';
import {
  DEFAULT_JOB_OPTS,
  ProcessMessageJob,
  QUEUE_MESSAGE_PROCESSING,
} from './queue.constants';

type MessageHandler = (job: ProcessMessageJob) => Promise<void>;

/**
 * Message dispatch with two drivers:
 *  - 'redis'  : durable BullMQ queue with retries (used when a real remote Redis
 *               is configured).
 *  - 'inline' : process directly in-process, no Redis required (fine for a
 *               single-owner assistant). Auto-selected when REDIS_URL is missing
 *               or points at localhost, so the app needs no paid Redis add-on.
 *
 * Idempotency is enforced downstream by the message processor's atomic claim, so
 * inline fire-and-forget is safe against WhatsApp webhook retries.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private queue?: Queue;
  private worker?: Worker;
  private handler?: MessageHandler;
  private readonly logger = new AppLogger('QueueService');

  driver(): 'redis' | 'inline' {
    const explicit = env().QUEUE_DRIVER;
    if (explicit) return explicit;
    const url = (env().REDIS_URL || '').trim();
    if (!url || url.includes('localhost') || url.includes('127.0.0.1')) return 'inline';
    return 'redis';
  }

  private connectionOptions(): ConnectionOptions {
    const url = new URL(env().REDIS_URL);
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username || undefined,
      password: url.password || undefined,
      family: url.hostname.endsWith('.railway.internal') ? 6 : undefined, // Railway private net is IPv6
      maxRetriesPerRequest: null,
    };
  }

  onModuleInit(): void {
    if (this.driver() !== 'redis') {
      this.logger.log('Queue driver: inline (no Redis required)');
      return;
    }
    try {
      this.queue = new Queue(QUEUE_MESSAGE_PROCESSING, { connection: this.connectionOptions() });
      this.logger.log('Queue driver: redis');
    } catch (e) {
      this.logger.error('Queue init failed — falling back to inline', { error: (e as Error).message });
      this.queue = undefined;
    }
  }

  /** Registered by the consumer module after construction. */
  registerMessageHandler(handler: MessageHandler): void {
    this.handler = handler;
    if (this.driver() !== 'redis' || !this.queue) return;

    this.worker = new Worker(
      QUEUE_MESSAGE_PROCESSING,
      async (job: Job<ProcessMessageJob>) => {
        if (!this.handler) throw new Error('No message handler registered');
        await this.handler(job.data);
      },
      { connection: this.connectionOptions() },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error('Job failed', {
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        error: err?.message,
      });
    });
  }

  async enqueueMessage(data: ProcessMessageJob): Promise<void> {
    if (this.driver() === 'redis' && this.queue) {
      await this.queue.add('process', data, {
        ...DEFAULT_JOB_OPTS,
        // idempotency at the queue level (BullMQ job ids must not contain ':')
        jobId: `msg-${data.whatsappMessageId}`,
      });
      return;
    }
    // Inline: process without blocking the webhook 200 response. Errors are
    // logged; the message row is left 'failed' for retry/visibility.
    this.runInline(data);
  }

  private runInline(data: ProcessMessageJob): void {
    if (!this.handler) {
      this.logger.error('No handler registered for inline processing');
      return;
    }
    setImmediate(() => {
      void this.handler!(data).catch((err) =>
        this.logger.error('Inline processing failed', {
          whatsappMessageId: data.whatsappMessageId,
          error: (err as Error).message,
        }),
      );
    });
  }

  async getFailedJobs(limit = 50) {
    if (this.driver() !== 'redis' || !this.queue) return [];
    return this.queue.getFailed(0, limit);
  }

  /** Diagnostics: queue driver + health (Redis ping, or 'n/a' for inline). */
  async status(): Promise<{ driver: string; healthy: boolean }> {
    const driver = this.driver();
    if (driver !== 'redis' || !this.queue) return { driver: 'inline', healthy: true };
    try {
      const client = (await this.queue.client) as unknown as { ping(): Promise<string> };
      return { driver: 'redis', healthy: (await client.ping()) === 'PONG' };
    } catch {
      return { driver: 'redis', healthy: false };
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
