import { z } from 'zod';

/**
 * THE single source of truth for the planner's intent set.
 *
 * Mirrors the tool-registry pattern: one tuple from which the Zod enum, the
 * specialist Record, and the router's option list are all DERIVED, so the three
 * can never drift. Adding an intent here forces a matching specialist (the
 * `Record<PlannerIntent, Specialist>` makes a missing one a COMPILE error) and
 * the router learns about it automatically from the specialist's routerHint.
 */
export const PLANNER_INTENTS = [
  'schedule', // meetings / calendar / availability / reminders / time-blocking
  'task', // to-dos, prioritization, breaking work down, follow-ups
  'document', // drafting documents and reports, background research
  'email', // outbound email/messages, finding a contact
  'chitchat', // casual talk / a general question — no action
  'general', // fallback: cross-domain / low-confidence → the monolith
] as const;

export type PlannerIntent = (typeof PLANNER_INTENTS)[number];

/**
 * The router's verdict for one message. `crossDomain` and a low `confidence`
 * both steer to the `general` monolith (see resolveIntent), so the cheap
 * specialists only run when the classification is clear and single-domain.
 */
export const routeDecisionSchema = z.object({
  intent: z.enum(PLANNER_INTENTS),
  crossDomain: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
});

export type RouteDecision = z.infer<typeof routeDecisionSchema>;
