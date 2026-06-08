import { PlannerContextInput } from '../planner.prompt';
import { SPECIALIST_LIST } from '../specialists/specialist.registry';

/**
 * The router's system prompt, DERIVED from the specialist registry: each
 * specialist contributes one option line from its routerHint, so adding a
 * specialist teaches the router about it automatically — no hard-coded intent
 * list in two places. `general` has no hint, so it is never offered as an
 * explicit option (the router falls back to it via low confidence / crossDomain).
 */
export function buildRouterSystemPrompt(): string {
  const options = SPECIALIST_LIST.filter((s) => s.routerHint)
    .map((s) => `- ${s.intent}: ${s.routerHint}`)
    .join('\n');
  return `You classify ONE incoming Hebrew WhatsApp message for a work assistant.
The owner is dyslexic and may use voice transcripts — read for INTENT, not spelling.
Pick the single best intent:
${options}

crossDomain=true ONLY if the message clearly needs TWO+ of these at once (e.g. schedule a meeting AND email someone). Set confidence honestly (how sure you are of the single intent).
Return ONLY JSON: {"intent": string, "crossDomain": boolean, "confidence": number}`;
}

/**
 * The router's user prompt — deliberately MINIMAL to keep the extra call cheap:
 * just the message content (and a one-line note if a pending item exists, since
 * that can change whether a casual-sounding reply is really an answer). No
 * memory/history — classification does not need them.
 */
export function buildRouterUserPrompt(ctx: PlannerContextInput): string {
  const lines: string[] = [];
  if (ctx.pendingClarification || ctx.pendingApproval) {
    lines.push('(NOTE: a pending question/approval is open — this may be an answer to it.)');
  }
  if (ctx.text) lines.push(`Text: ${ctx.text}`);
  if (ctx.transcript) lines.push(`Voice transcript: ${ctx.transcript}`);
  if (ctx.mediaSummary) lines.push(`Media summary: ${ctx.mediaSummary}`);
  if (!ctx.text && !ctx.transcript && !ctx.mediaSummary) {
    lines.push('(no usable content)');
  }
  return lines.join('\n');
}
