import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AiService } from '../ai/ai.service';
import { AppLogger } from '../logger/logger.service';
import { PrismaService } from '../prisma/prisma.service';

export type DocumentType =
  | 'Meeting Summary'
  | 'Client Call Report'
  | 'Site Visit Report'
  | 'Action Items Report'
  | 'Incident Report'
  | 'Project Status Update'
  | 'Decision Memo'
  | 'Proposal Draft'
  | 'Internal Memo';

export interface DraftDocumentInput {
  documentType: DocumentType;
  title: string;
  sourceMaterial: string;
  project?: string | null;
  client?: string | null;
  sourceMessageId?: string | null;
  sourceMediaId?: string | null;
  language?: string;
}

const docDraftSchema = z.object({
  body: z.string(),
  missingFacts: z.array(z.string()).default([]),
});

const DOC_SYSTEM_PROMPT = `You draft professional ENGLISH work documents from source material (notes, transcripts, image/video summaries).
STRICT ANTI-HALLUCINATION RULES:
- NEVER invent facts, names, dates, numbers, prices, decisions, or quotes.
- If an important fact is missing, write a placeholder exactly like [Missing: client name] and add it to "missingFacts".
- Do not fabricate official wording when facts are absent.

Use this structure with headings:
1. Title
2. Date
3. Prepared for / Prepared by
4. Project / Client
5. Context
6. Summary
7. Key Details
8. Decisions
9. Action Items
10. Risks / Open Questions
11. Next Steps
12. Appendix: Source Material (include the original source verbatim)

Return ONLY JSON: {"body": string, "missingFacts": string[]}.`;

/**
 * Generates English document drafts. Never marks a document official or shares
 * it — that requires approval handled by the executor. Missing facts become
 * placeholders and are surfaced so the owner can be asked.
 */
@Injectable()
export class DocumentAgentService {
  private readonly logger = new AppLogger('DocumentAgentService');

  constructor(
    private readonly ai: AiService,
    private readonly prisma: PrismaService,
  ) {}

  async draft(input: DraftDocumentInput): Promise<{
    id: string;
    content: string;
    missingFacts: string[];
  }> {
    const userPrompt = [
      `Document type: ${input.documentType}`,
      `Title: ${input.title}`,
      input.project ? `Project: ${input.project}` : 'Project: [Missing: project]',
      input.client ? `Client: ${input.client}` : 'Client: [Missing: client]',
      `Date generated: ${new Date().toISOString().slice(0, 10)}`,
      '--- SOURCE MATERIAL (verbatim) ---',
      input.sourceMaterial || '[Missing: source material]',
    ].join('\n');

    let content = '';
    let missingFacts: string[] = [];
    try {
      const raw = await this.ai.complete({
        system: DOC_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        jsonMode: true,
        temperature: 0,
        maxTokens: 3000,
        tier: 'heavy', // official documents need the stronger model
      });
      const parsed = docDraftSchema.parse(JSON.parse(raw.trim()));
      content = parsed.body;
      missingFacts = parsed.missingFacts;
    } catch (e) {
      this.logger.warn('Document draft generation failed validation', {
        error: (e as Error).message,
      });
      content = `[Draft could not be generated automatically]\n\nSource material:\n${input.sourceMaterial}`;
      missingFacts = ['document_body'];
    }

    const doc = await this.prisma.documentDraft.create({
      data: {
        title: input.title,
        documentType: input.documentType,
        language: input.language ?? 'en',
        status: 'draft',
        content,
        sourceMessageId: input.sourceMessageId ?? null,
        sourceMediaId: input.sourceMediaId ?? null,
      },
    });

    return { id: doc.id, content, missingFacts };
  }
}
