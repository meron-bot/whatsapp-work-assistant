import { buildToolsSection } from '../../orchestration/tool-registry';
import {
  ASSUMPTIONS_BLOCK,
  APPROVAL_BLOCK,
  CONFIDENCE_BLOCK,
  LEARNING_BLOCK,
  PENDING_BLOCK,
  PLANNER_CORE,
  PLANNER_OUTPUT_SCHEMA,
} from '../planner-shared';
import { PlannerIntent, RouteDecision } from '../router/route.schema';
import { chitchatSpecialist } from './chitchat.specialist';
import { documentSpecialist } from './document.specialist';
import { emailSpecialist } from './email.specialist';
import { generalSpecialist } from './general.specialist';
import { scheduleSpecialist } from './schedule.specialist';
import { Specialist } from './specialist.types';
import { taskSpecialist } from './task.specialist';

/**
 * THE registry: a full Record from every intent to its specialist. Because it is
 * typed `Record<PlannerIntent, Specialist>`, adding an intent to PLANNER_INTENTS
 * without a specialist here is a COMPILE error — the single source of truth for
 * "which specialist plans this intent".
 */
export const SPECIALISTS: Record<PlannerIntent, Specialist> = {
  schedule: scheduleSpecialist,
  task: taskSpecialist,
  document: documentSpecialist,
  email: emailSpecialist,
  chitchat: chitchatSpecialist,
  general: generalSpecialist,
};

/** All specialists, for deriving the router's option list. */
export const SPECIALIST_LIST: readonly Specialist[] = Object.values(SPECIALISTS);

/**
 * Assemble a specialist's system prompt from the single-source blocks, in the
 * canonical order of the original monolithic prompt
 * (CORE → TOOLS → ASSUMPTIONS → APPROVAL → CONFIDENCE → PENDING → LEARNING →
 * SCHEMA). A narrow specialist simply drops blocks; the rest keep their order, so
 * `general` (all blocks) is byte-identical to the previous prompt.
 */
export function buildSpecialistSystemPrompt(s: Specialist): string {
  const b = s.blocks ?? {};
  return [
    PLANNER_CORE,
    s.tools.length ? buildToolsSection(s.tools) : '',
    b.assumptions !== false ? ASSUMPTIONS_BLOCK : '',
    b.approval === true ? APPROVAL_BLOCK : '',
    b.confidence !== false ? CONFIDENCE_BLOCK : '',
    b.pending !== false ? PENDING_BLOCK : '',
    b.learning !== false ? LEARNING_BLOCK : '',
    PLANNER_OUTPUT_SCHEMA,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Below this confidence the router's verdict is not trusted and we fall back to
 * the safe (more expensive) general monolith. Tuned after live observation.
 */
const CONFIDENCE_FLOOR = 0.6;

/**
 * Map a router decision to the intent we actually plan with. A cross-domain or
 * low-confidence verdict — or no decision at all (router disabled) — resolves to
 * `general`, so the cheap specialists only run on a clear, single-domain message.
 */
export function resolveIntent(route?: RouteDecision): PlannerIntent {
  if (!route) return 'general';
  if (route.crossDomain || route.confidence < CONFIDENCE_FLOOR) return 'general';
  return route.intent;
}

/**
 * Back-compat / regression anchor: the full general prompt, derived from the
 * blocks. Byte-identical to the previous monolithic PLANNER_SYSTEM_PROMPT (proven
 * by test/planner-prompt.golden.spec.ts).
 */
export const PLANNER_SYSTEM_PROMPT = buildSpecialistSystemPrompt(generalSpecialist);
