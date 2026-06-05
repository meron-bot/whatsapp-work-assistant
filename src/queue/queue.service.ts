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
 * Thin wrapper around BullMQ. Owns the connection, the producer queue and the
 * worker. The processing handler is registered by the WhatsApp module to avoid
 * a circular dependency.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private queue!: Queue;
  private worker?: Worker;
  private handler?: MessageHandler;
  private readonly logger = new AppLogger('QueueService');

  /** Build a BullMQ connection options object from the configured REDIS_URL. */
  private connectionOptions(): ConnectionOptions {
    const raw = env().REDIS_URL;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      this.logger.error('Invalid REDIS_URL — falling back to localhost', { raw });
      url = new URL('redis://localhost:6379');
    }
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
    // Never let queue setup crash startup; the HTTP server must come online.
    try {
      this.queue = new Queue(QUEUE_MESSAGE_PROCESSING, { connection: this.connectionOptions() });
    } catch (e) {
      this.logger.error('Queue init failed (continuing)', { error: (e as Error).message });
    }
  }

  /** Registered by the consumer module after construction. */
  registerMessageHandler(handler: MessageHandler): void {
    this.handler = handler;
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
    await this.queue.add('process', data, {
      ...DEFAULT_JOB_OPTS,
      // idempotency at the queue level (BullMQ job ids must not contain ':')
      jobId: `msg-${data.whatsappMessageId}`,
    });
  }

  async getFailedJobs(limit = 50) {
    return this.queue.getFailed(0, limit);
  }

  /** Lightweight Redis connectivity check for diagnostics. */
  async checkRedis(): Promise<boolean> {
    try {
      if (!this.queue) return false;
      const client = (await this.queue.client) as unknown as {
        ping(): Promise<string>;
      };
      const pong = await client.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
