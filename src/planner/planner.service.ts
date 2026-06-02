import { Injectable } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { AppLogger } from '../logger/logger.service';
import {
  buildPlannerUserPrompt,
  PLANNER_SYSTEM_PROMPT,
  PlannerContextInput,
} from './planner.prompt';
import { PlannerOutput, plannerOutputSchema } from './planner.schema';

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
    const userPrompt = buildPlannerUserPrompt(ctx);
    let raw = '';
    try {
      raw = await this.ai.complete({
        system: PLANNER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        jsonMode: true,
        temperature: 0,
        maxTokens: 2000,
      });
      const parsed = this.safeParseJson(raw);
      return plannerOutputSchema.parse(parsed);
    } catch (e) {
      this.logger.error('Planner output invalid, falling back to clarification', {
        error: (e as Error).message,
        rawPreview: raw.slice(0, 300),
      });
      return this.fallbackClarification();
    }
  }

  private safeParseJson(raw: string): unknown {
    // Be tolerant of stray markdown fences but never of missing structure.
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();
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
        'לא הצלחתי להבין את הבקשה בצורה ברורה. אפשר לנסח שוב מה צריך לעשות?',
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
      replyToUser:
        'לא הצלחתי להבין את הבקשה בצורה ברורה. אפשר לנסח שוב מה צריך לעשות?',
    };
  }
}
