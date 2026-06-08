/**
 * The per-message USER prompt for the planner, plus the context type it is built
 * from.
 *
 * The SYSTEM prompt no longer lives here: its reusable blocks are in
 * planner-shared.ts and are assembled per-intent by the specialist registry
 * (specialists/specialist.registry.ts). `PLANNER_SYSTEM_PROMPT` (the full general
 * prompt) is still exported from that registry for anything that wants the
 * monolithic prompt verbatim.
 */
import { RouteDecision } from './router/route.schema';

export interface PlannerContextInput {
  text: string | null;
  transcript: string | null;
  mediaSummary: string | null;
  sender: string;
  timestamp: string;
  timezone: string;
  ownerName?: string;
  recentContext?: string;
  pendingClarification?: { id: string; question: string; missingFields: unknown } | null;
  pendingApproval?: { id: string; description: string } | null;
  knownProjects?: string[];
  memories?: string[];
  /** Results from tools the planner requested on a previous pass (resolution loop). */
  toolFindings?: string[];
  /**
   * The router's intent decision, made ONCE per message and carried unchanged
   * through every resolution-loop re-plan (so the router runs at most once and
   * the specialist never switches mid-message). Absent when the router is
   * disabled — the planner then uses the general monolith.
   */
  route?: RouteDecision;
}

export function buildPlannerUserPrompt(ctx: PlannerContextInput): string {
  const lines: string[] = [];
  if (ctx.ownerName) {
    lines.push(
      `You are the assistant (פליי). The human owner you serve is ${ctx.ownerName}. Do NOT greet them by name or open with their name — answer directly.`,
    );
  }
  lines.push(`Owner timezone: ${ctx.timezone}`);
  lines.push(`Message timestamp: ${ctx.timestamp}`);
  if (ctx.knownProjects?.length) {
    lines.push(`Known projects: ${ctx.knownProjects.join(', ')}`);
  }
  if (ctx.memories?.length) {
    lines.push(`Known facts about the owner (honor these; do not re-ask):\n${ctx.memories.join('\n')}`);
  }
  if (ctx.recentContext) {
    lines.push(
      `RECENT CONVERSATION (oldest first; "${ctx.ownerName ?? 'the owner'}" is the owner, ` +
        `"פליי" is you, the assistant). The owner often supplies details across SEVERAL ` +
        `messages. Read this whole thread and COMBINE everything already stated with the ` +
        `incoming message before deciding anything is missing. Do NOT ask again for any ` +
        `detail (dates, times, names, duration, location, platform) that already appears ` +
        `above — if it is here, treat it as known.\n${ctx.recentContext}`,
    );
  }
  if (ctx.toolFindings?.length) {
    lines.push(
      `TOOL FINDINGS (results of tools you requested — use these to finalize; do NOT re-request the same tool):\n${ctx.toolFindings.join('\n')}`,
    );
  }
  if (ctx.pendingClarification) {
    lines.push(
      `PENDING CLARIFICATION the owner may be answering:\n` +
        `question: ${ctx.pendingClarification.question}\n` +
        `missingFields: ${JSON.stringify(ctx.pendingClarification.missingFields)}`,
    );
  }
  if (ctx.pendingApproval) {
    lines.push(
      `PENDING APPROVAL the owner may be responding to:\n${ctx.pendingApproval.description}`,
    );
  }
  lines.push('--- INCOMING MESSAGE ---');
  if (ctx.text) lines.push(`Text: ${ctx.text}`);
  if (ctx.transcript) lines.push(`Voice transcript: ${ctx.transcript}`);
  if (ctx.mediaSummary) lines.push(`Media summary: ${ctx.mediaSummary}`);
  if (!ctx.text && !ctx.transcript && !ctx.mediaSummary) {
    lines.push('(no usable content)');
  }
  return lines.join('\n\n');
}
