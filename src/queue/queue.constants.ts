export const QUEUE_MESSAGE_PROCESSING = 'message-processing';

export interface ProcessMessageJob {
  whatsappMessageId: string;
}

/**
 * Shared BullMQ job options. Exponential backoff + retries with a dead-letter
 * (failed jobs stay in the failed set and are surfaced in the admin UI).
 */
export const DEFAULT_JOB_OPTS = {
  attempts: 4,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};
