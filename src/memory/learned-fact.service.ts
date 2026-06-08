import { Injectable } from '@nestjs/common';
import { LearnedFact, MemoryType, Prisma } from '@prisma/client';
import { AppLogger } from '../logger/logger.service';
import { PrismaService } from '../prisma/prisma.service';

export interface MemoryWriteInput {
  type: MemoryType;
  subject?: string | null;
  content: string;
  structured?: Record<string, unknown> | null;
  confidence?: number;
  source?: string | null;
}

/** Types that are always relevant regardless of the current message. */
const GLOBAL_TYPES: MemoryType[] = ['preference', 'glossary'];

/** Hard cap on how many facts we inject into a prompt, to bound token cost. */
const MAX_INJECTED = 12;

/**
 * The learning layer. Stores durable, owner-specific facts and serves the
 * relevant ones back into the planner prompt.
 *
 * Cost note: retrieval is pure SQL + in-process keyword matching — NO embeddings
 * and NO extra AI calls. Writes are produced as a by-product of the planner call
 * that already runs, so learning adds zero requests on the hot path.
 */
@Injectable()
export class LearnedFactService {
  private readonly logger = new AppLogger('LearnedFact');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Select the facts most relevant to the incoming message and format them as
   * prompt lines. Global preferences/glossary are always included; everything
   * else is matched by keyword overlap. Bumps useCount on what we surface so
   * relevance ranking improves over time.
   */
  async retrieveForPrompt(message: string): Promise<string[]> {
    const all = await this.prisma.learnedFact.findMany({
      where: { active: true },
      orderBy: [{ confidence: 'desc' }, { useCount: 'desc' }, { updatedAt: 'desc' }],
    });
    if (!all.length) return [];

    const tokens = this.tokenize(message);
    const selected: LearnedFact[] = [];
    for (const fact of all) {
      if (selected.length >= MAX_INJECTED) break;
      const isGlobal = GLOBAL_TYPES.includes(fact.type);
      if (isGlobal || this.matches(fact, tokens)) selected.push(fact);
    }

    if (selected.length) {
      const ids = selected.map((f) => f.id);
      await this.prisma.learnedFact.updateMany({
        where: { id: { in: ids } },
        data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
      });
    }

    return selected.map((f) => this.toLine(f));
  }

  /**
   * Persist facts the planner extracted from a message. Idempotent: an identical
   * fact (same type + subject + content) reinforces the existing row's
   * confidence instead of creating a duplicate.
   */
  async applyWrites(writes: MemoryWriteInput[], source?: string | null): Promise<void> {
    for (const w of writes) {
      const content = w.content?.trim();
      if (!content) continue;
      try {
        await this.upsert({ ...w, content, source: w.source ?? source ?? null });
      } catch (e) {
        this.logger.warn('Failed to persist learned fact', { error: (e as Error).message });
      }
    }
  }

  private async upsert(w: MemoryWriteInput): Promise<void> {
    const subject = w.subject?.trim() || null;
    const existing = await this.prisma.learnedFact.findFirst({
      where: {
        type: w.type,
        subject, // null matches rows whose subject IS NULL (exact, not "ignore")
        content: { equals: w.content, mode: 'insensitive' },
      },
    });

    if (existing) {
      await this.prisma.learnedFact.update({
        where: { id: existing.id },
        data: {
          active: true,
          confidence: Math.min(0.99, existing.confidence + 0.1),
          useCount: { increment: 1 },
        },
      });
      return;
    }

    await this.prisma.learnedFact.create({
      data: {
        type: w.type,
        subject,
        content: w.content.slice(0, 1000),
        structured: (w.structured ?? undefined) as Prisma.InputJsonValue | undefined,
        confidence: w.confidence ?? 0.7,
        source: w.source ?? null,
      },
    });
  }

  /** All active facts, for the "what do you remember about me?" command. */
  listActive(): Promise<LearnedFact[]> {
    return this.prisma.learnedFact.findMany({
      where: { active: true },
      orderBy: [{ type: 'asc' }, { confidence: 'desc' }],
    });
  }

  /** Deactivate specific facts by id (used by the weekly reflection job to prune
   *  duplicates/obsolete facts). Returns how many were actually deactivated. */
  async deactivate(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const res = await this.prisma.learnedFact.updateMany({
      where: { id: { in: ids }, active: true },
      data: { active: false },
    });
    return res.count;
  }

  /** Deactivate facts whose subject/content matches a free-text query. */
  async forget(query: string): Promise<number> {
    const q = query.trim();
    if (!q) return 0;
    const res = await this.prisma.learnedFact.updateMany({
      where: {
        active: true,
        OR: [
          { content: { contains: q, mode: 'insensitive' } },
          { subject: { contains: q, mode: 'insensitive' } },
        ],
      },
      data: { active: false },
    });
    return res.count;
  }

  // --- helpers ---

  private tokenize(message: string): string[] {
    return (message || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3);
  }

  /** A fact matches if its subject or any content word overlaps the message. */
  private matches(fact: LearnedFact, tokens: string[]): boolean {
    if (!tokens.length) return false;
    const haystack = `${fact.subject ?? ''} ${fact.content}`.toLowerCase();
    return tokens.some((t) => haystack.includes(t));
  }

  private toLine(f: LearnedFact): string {
    const label = f.subject ? `${f.type} (${f.subject})` : f.type;
    return `- [${label}] ${f.content}`;
  }
}
