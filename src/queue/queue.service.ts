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
    const url = new URL(env().REDIS_URL);
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username || undefined,
      password: url.password || undefined,
      maxRetriesPerRequest: null,
    };
  }

  onModuleInit(): void {
    this.queue = new Queue(QUEUE_MESSAGE_PROCESSING, { connection: this.connectionOptions() });
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
      jobId: `msg:${data.whatsappMessageId}`, // idempotency at the queue level
    });
  }

  async getFailedJobs(limit = 50) {
    return this.queue.getFailed(0, limit);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
