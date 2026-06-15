import { z } from 'zod';
import { TOOL_NAMES } from '../orchestration/tool-registry';

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
  'send_email',
  // Mutations of existing items ("תזיז את הפגישה", "סיימתי", "בטל את התזכורת").
  // The target is identified by toolPayload.targetId (the id shown in the
  // recent-actions digest) or, failing that, by title match.
  'update_task',
  'complete_task',
  'update_calendar_event',
  'cancel_calendar_event',
  'cancel_reminder',
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

/**
 * Sub-agent / tool the planner can invoke to resolve missing context BEFORE
 * asking the owner. The processor runs each request, feeds the findings back,
 * and re-plans. This is the heart of "solve before you ask".
 *
 * The set of tools is defined ONCE in the tool registry
 * (../orchestration/tool-registry); this enum is derived from it so the schema,
 * the prompt, and the executor can never drift apart.
 */
export const toolRequestEnum = z.enum(TOOL_NAMES);

export const toolRequestSchema = z.object({
  tool: toolRequestEnum,
  query: z.string(),
  reason: z.string().nullable().default(null),
});

export const memoryTypeEnum = z.enum([
  'preference',
  'contact',
  'project_fact',
  'pattern',
  'correction',
  'glossary',
]);

/**
 * A durable fact the planner learned from this message (an explicit preference,
 * a correction, a new contact/project detail). Persisted to the learning layer
 * and injected into future prompts. Only emit facts that are clearly stated and
 * worth remembering — never guesses.
 */
export const memoryWriteSchema = z.object({
  type: memoryTypeEnum,
  subject: z.string().nullable().default(null),
  content: z.string(),
  confidence: z.number().min(0).max(1).default(0.7),
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
  // Resolve-before-ask: tools/sub-agents to run before finalizing. When this is
  // non-empty the processor runs them, feeds findings back, and re-plans.
  toolRequests: z.array(toolRequestSchema).default([]),
  // Reasonable assumptions the planner made and is stating to the owner (e.g.
  // "assumed 60 min", "assumed 09:00"). Surfaced so the owner can correct.
  assumptions: z.array(z.string()).default([]),
  actions: z.array(plannerActionSchema).default([]),
  memoryWrites: z.array(memoryWriteSchema).default([]),
  replyToUser: z.string(),
});

export type PlannerAction = z.infer<typeof plannerActionSchema>;
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;
export type ActionType = z.infer<typeof actionTypeEnum>;
export type MemoryWrite = z.infer<typeof memoryWriteSchema>;
export type ToolRequest = z.infer<typeof toolRequestSchema>;
export type ToolName = z.infer<typeof toolRequestEnum>;
