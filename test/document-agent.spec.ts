import { DocumentAgentService } from '../src/documents/document-agent.service';

process.env.DATABASE_URL = 'postgresql://x';

describe('DocumentAgentService anti-hallucination', () => {
  // (18) Document anti-hallucination policy
  it('keeps placeholders and surfaces missing facts instead of inventing them', async () => {
    const ai = {
      complete: jest.fn().mockResolvedValue(
        JSON.stringify({
          body: 'Client Call Report\nClient: [Missing: client name]\nSummary: ...',
          missingFacts: ['client name', 'call date'],
        }),
      ),
    } as any;
    const prisma = {
      documentDraft: { create: jest.fn().mockResolvedValue({ id: 'doc1' }) },
    } as any;

    const svc = new DocumentAgentService(ai, prisma);
    const result = await svc.draft({
      documentType: 'Client Call Report',
      title: 'Call report',
      sourceMaterial: 'Spoke with the client briefly.',
    });

    expect(result.missingFacts).toContain('client name');
    expect(result.content).toContain('[Missing: client name]');
    expect(prisma.documentDraft.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'draft', language: 'en' }),
    });
  });

  it('degrades safely when the AI output is invalid', async () => {
    const ai = { complete: jest.fn().mockResolvedValue('not json') } as any;
    const prisma = {
      documentDraft: { create: jest.fn().mockResolvedValue({ id: 'doc2' }) },
    } as any;
    const svc = new DocumentAgentService(ai, prisma);
    const result = await svc.draft({
      documentType: 'Internal Memo',
      title: 'Memo',
      sourceMaterial: 'some note',
    });
    expect(result.missingFacts).toContain('document_body');
    expect(result.content).toContain('some note');
  });
});
