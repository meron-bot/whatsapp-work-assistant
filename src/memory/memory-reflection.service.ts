import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { z } from 'zod';
import { AiService } from '../ai/ai.service';
import { AppLogger } from '../logger/logger.service';
import { LearnedFactService } from './learned-fact.service';

/** The model's verdict: which fact ids to deactivate (duplicates / obsolete). */
const reflectionSchema = z.object({
  deactivate: z
    .array(z.object({ id: z.string(), reason: z.string().nullable().default(null) }))
    .default([]),
});

const REFLECTION_SYSTEM_PROMPT = `You curate the long-term memory of a personal WhatsApp work assistant. You are given the assistant's current remembered facts about its owner, one per line as: <id> | <fact>.

Identify ONLY facts that are EXACT DUPLICATES of another fact, or that are clearly OBSOLETE because a newer fact in the list supersedes them (e.g. an updated phone/email/preference). List the ids to deactivate.

Be CONSERVATIVE: when in doubt, KEEP the fact. Never deactivate a fact that carries any unique information. When two facts overlap, keep the more specific / more recent one and deactivate only the redundant one.

Return ONLY JSON: {"deactivate":[{"id": string, "reason": string}]}. If nothing should change, return {"deactivate":[]}.`;

/** Hard cap on facts sent to the model, to bound token cost on a large memory. */
const MAX_FACTS = 200;

/**
 * Weekly self-improvement of the learning layer (agent spec חלק ה׳). A single
 * heavy-model pass merges duplicates and prunes obsolete facts by DEACTIVATING
 * them (reversible — `active=false`, never a hard delete). NEVER throws: a failed
 * reflection just logs and leaves memory untouched.
 */
@Injectable()
export class MemoryReflectionService {
  private readonly logger = new AppLogger('MemoryReflection');

  constructor(
    private readonly ai: AiService,
    private readonly memory: LearnedFactService,
  ) {}

  @Cron('0 3 * * 0', { timeZone: 'Asia/Jerusalem' })
  async reflect(): Promise<number> {
    try {
      return await this.runReflection();
    } catch (e) {
      this.logger.warn('Memory reflection failed', { error: (e as Error).message });
      return 0;
    }
  }

  private async runReflection(): Promise<number> {
    const facts = await this.memory.listActive();
    if (facts.length < 2) return 0; // nothing to merge

    const list = facts
      .slice(0, MAX_FACTS)
      .map((f) => `${f.id} | [${f.type}${f.subject ? ` ${f.subject}` : ''}] ${f.content}`)
      .join('\n');

    const raw = await this.ai.complete({
      tier: 'heavy',
      temperature: 0,
      maxTokens: 1000,
      jsonMode: true,
      system: REFLECTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Current memory:\n${list}` }],
    });

    const parsed = reflectionSchema.parse(this.parseJson(raw));
    // Only act on ids the model was actually shown (never trust a fabricated id).
    const valid = new Set(facts.map((f) => f.id));
    const ids = parsed.deactivate.map((d) => d.id).filter((id) => valid.has(id));
    if (!ids.length) return 0;

    const count = await this.memory.deactivate(ids);
    this.logger.log('Memory reflection pruned redundant facts', { count });
    return count;
  }

  /** Tolerant of stray markdown fences; never of missing structure. */
  private parseJson(raw: string): unknown {
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
