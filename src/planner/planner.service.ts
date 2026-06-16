import { Injectable } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { AppLogger } from '../logger/logger.service';
import { buildPlannerUserPrompt, PlannerContextInput } from './planner.prompt';
import { PlannerOutput, plannerOutputSchema } from './planner.schema';
import {
  buildSpecialistSystemPrompt,
  resolveIntent,
  SPECIALISTS,
} from './specialists/specialist.registry';
import { Specialist } from './specialists/specialist.types';

/**
 * Turns a normalized incoming message into a validated plan. If the model
 * returns invalid JSON or fails schema validation, we DO NOT guess — we fall
 * back to a safe clarification plan so nothing actionable is lost or invented.
 */
@Injectable()
export class PlannerService {
  private readonly logger = new AppLogger('PlannerService');

  constructor(private readonly ai: AiService) {}

  async plan(ctx: PlannerContextInput): Promise<PlannerOutput> {
    // The router (when enabled) picks a specialist; a missing/low-confidence/
    // cross-domain route resolves to the general monolith — zero behaviour change.
    const specialist = SPECIALISTS[resolveIntent(ctx.route)];

    // Cost tiering: try the cheap model first; escalate to the heavy model only
    // when the light one fails validation or returns a low-confidence result.
    // Long/multi-part messages skip the light tier entirely — the light model
    // tends to drop items from them, and its doomed attempt costs a round-trip.
    const light = this.isLongRequest(ctx) ? null : await this.attempt(ctx, specialist, 'light');
    if (light && light.confidence >= 0.6) return light;

    const heavy = await this.attempt(ctx, specialist, 'heavy');
    if (heavy) return heavy;

    // If the heavy model also failed, keep any valid (low-confidence) light
    // result; otherwise fall back to a safe clarification.
    if (light) return light;
    return this.fallbackClarification();
  }

  /** A long message (typed or voice) almost certainly carries several requests
   *  or rich detail — plan it on the heavy model from the start. */
  private isLongRequest(ctx: PlannerContextInput): boolean {
    const content = [ctx.text, ctx.transcript].filter(Boolean).join(' ');
    return content.length > 350;
  }

  /** One planning attempt at a given cost tier. Returns null on invalid output. */
  private async attempt(
    ctx: PlannerContextInput,
    specialist: Specialist,
    tier: 'light' | 'heavy',
  ): Promise<PlannerOutput | null> {
    const userPrompt = buildPlannerUserPrompt(ctx);
    let raw = '';
    try {
      raw = await this.ai.complete({
        system: buildSpecialistSystemPrompt(specialist),
        messages: [{ role: 'user', content: userPrompt }],
        jsonMode: true,
        temperature: 0,
        // A multi-action plan for a long message easily exceeds 2000 tokens of
        // JSON; a truncated object fails parsing and used to surface as "לא
        // הצלחתי להבין" on perfectly clear (just long) requests.
        maxTokens: 6000,
        tier,
      });
      return plannerOutputSchema.parse(this.safeParseJson(raw));
    } catch (e) {
      this.logger.warn(`Planner ${tier} output invalid`, {
        error: (e as Error).message,
        rawPreview: raw.slice(0, 200),
      });
      return null;
    }
  }

  private safeParseJson(raw: string): unknown {
    // Be tolerant of stray markdown fences / surrounding prose, but never of
    // missing structure. Extract the outermost JSON object if present.
    let cleaned = raw
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      cleaned = cleaned.slice(first, last + 1);
    }
    return JSON.parse(cleaned);
  }

  /** Safe default when we cannot trust the AI output. */
  private fallbackClarification(): PlannerOutput {
    return {
      summary: 'Could not interpret the message reliably.',
      confidence: 0,
      language: 'he',
      isAnswerToPendingClarification: false,
      isAnswerToPendingApproval: false,
      detectedProject: null,
      detectedClient: null,
      missingInformation: [
        { field: 'intent', reason: 'AI output could not be validated', importance: 'high' },
      ],
      needsClarification: true,
      clarificationQuestion:
        'סליחה, משהו אצלי נתקע ולא הספקתי לעבד את ההודעה — זה לא אתה. תוכל לשלוח שוב? אם יש כמה דברים, שורה לכל דבר תעזור לי לא לפספס.',
      toolRequests: [],
      assumptions: [],
      actions: [
        {
          type: 'ask_clarification',
          title: 'Clarify unintelligible request',
          description: null,
          confidence: 0,
          priority: null,
          dueDate: null,
          startTime: null,
          endTime: null,
          participants: [],
          project: null,
          client: null,
          requiresApproval: false,
          approvalReason: null,
          missingFields: ['intent'],
          toolPayload: {},
        },
      ],
      memoryWrites: [],
      replyToUser:
        'סליחה, משהו אצלי נתקע ולא הספקתי לעבד את ההודעה — זה לא אתה. תוכל לשלוח שוב? אם יש כמה דברים, שורה לכל דבר תעזור לי לא לפספס.',
    };
  }
}
