import { Injectable } from '@nestjs/common';
import { AiService } from '../../ai/ai.service';
import { AppLogger } from '../../logger/logger.service';
import { PlannerContextInput } from '../planner.prompt';
import {
  buildRouterSystemPrompt,
  buildRouterUserPrompt,
} from './planner-router.prompt';
import { RouteDecision, routeDecisionSchema } from './route.schema';

/**
 * The light router: one cheap classification call that picks which specialist
 * plans the message. It NEVER throws — any failure (bad JSON, model error)
 * resolves to the safe `general` monolith, so a flaky router can never break
 * message processing or change behaviour silently.
 */
@Injectable()
export class PlannerRouterService {
  private readonly logger = new AppLogger('PlannerRouter');

  constructor(private readonly ai: AiService) {}

  async classify(ctx: PlannerContextInput): Promise<RouteDecision> {
    try {
      const raw = await this.ai.complete({
        system: buildRouterSystemPrompt(),
        messages: [{ role: 'user', content: buildRouterUserPrompt(ctx) }],
        jsonMode: true,
        temperature: 0,
        maxTokens: 150,
        tier: 'light',
      });
      return routeDecisionSchema.parse(this.safeParseJson(raw));
    } catch (e) {
      this.logger.warn('Router failed → general', { error: (e as Error).message });
      // Safe fallback = the monolith: confidence 0 makes resolveIntent pick general.
      return { intent: 'general', crossDomain: false, confidence: 0 };
    }
  }

  /** Tolerant of stray markdown fences / surrounding prose; never of missing structure. */
  private safeParseJson(raw: string): unknown {
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
}
