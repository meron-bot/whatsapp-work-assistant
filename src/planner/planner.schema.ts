import { z } from 'zod';

/**
 * Strict Zod schema for planner output. Any AI response that does not match is
 * rejected and treated as a failure (fallback -> clarification), so the system
 * never acts on malformed or hallucinated structure.
 */

export const actionTypeEnum = z.enum([
  'create_task',
  'create_calendar_event',
  'create_reminder',
  'draft_document',
  'save_file',
  'ask_clarification',
  'request_approval',
  'ignore',
]);

export const plannerActionSchema = z.object({
  type: actionTypeEnum,
  title: z.string(),
  description: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).nullable().default(null),
  dueDate: z.string().nullable().default(null),
  startTime: z.string().nullable().default(null),
  endTime: z.string().nullable().default(null),
  participants: z.array(z.string()).default([]),
  project: z.string().nullable().default(null),
  client: z.string().nullable().default(null),
  requiresApproval: z.boolean().default(false),
  approvalReason: z.string().nullable().default(null),
  missingFields: z.array(z.string()).default([]),
  toolPayload: z.record(z.any()).default({}),
});

export const missingInformationSchema = z.object({
  field: z.string(),
  reason: z.string(),
  importance: z.enum(['low', 'medium', 'high']),
});

export const plannerOutputSchema = z.object({
  summary: z.string(),
  confidence: z.number().min(0).max(1),
  language: z.enum(['he', 'en', 'mixed']),
  isAnswerToPendingClarification: z.boolean().default(false),
  isAnswerToPendingApproval: z.boolean().default(false),
  detectedProject: z.string().nullable().default(null),
  detectedClient: z.string().nullable().default(null),
  missingInformation: z.array(missingInformationSchema).default([]),
  needsClarification: z.boolean().default(false),
  clarificationQuestion: z.string().nullable().default(null),
  actions: z.array(plannerActionSchema).default([]),
  replyToUser: z.string(),
});

export type PlannerAction = z.infer<typeof plannerActionSchema>;
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;
export type ActionType = z.infer<typeof actionTypeEnum>;
