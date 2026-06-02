import { PlannerService } from '../src/planner/planner.service';
import { plannerOutputSchema } from '../src/planner/planner.schema';
import { AiService } from '../src/ai/ai.service';

process.env.DATABASE_URL = 'postgresql://x';
process.env.OWNER_WHATSAPP_NUMBER = '972500000000';
process.env.WHATSAPP_ACCESS_TOKEN = 'x';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'x';
process.env.WHATSAPP_VERIFY_TOKEN = 'v';

function fakeAi(response: string): AiService {
  return { complete: jest.fn().mockResolvedValue(response) } as unknown as AiService;
}

const validOutput = {
  summary: 'Create a task',
  confidence: 0.9,
  language: 'he',
  isAnswerToPendingClarification: false,
  isAnswerToPendingApproval: false,
  detectedProject: null,
  detectedClient: null,
  missingInformation: [],
  needsClarification: false,
  clarificationQuestion: null,
  actions: [
    {
      type: 'create_task',
      title: 'שליחת הצעה לאבי',
      description: null,
      confidence: 0.9,
      priority: 'medium',
      dueDate: null,
      startTime: null,
      endTime: null,
      participants: [],
      project: null,
      client: null,
      requiresApproval: false,
      approvalReason: null,
      missingFields: [],
      toolPayload: {},
    },
  ],
  replyToUser: 'יצרתי משימה.',
};

describe('PlannerService', () => {
  const ctx = {
    text: 'תזכיר לי לשלוח לאבי את ההצעה',
    transcript: null,
    mediaSummary: null,
    sender: '972500000000',
    timestamp: new Date().toISOString(),
    timezone: 'Asia/Jerusalem',
  };

  it('parses and validates a well-formed planner response', async () => {
    const planner = new PlannerService(fakeAi(JSON.stringify(validOutput)));
    const out = await planner.plan(ctx);
    expect(out.actions[0].type).toBe('create_task');
    expect(plannerOutputSchema.safeParse(out).success).toBe(true);
  });

  // (19) Zod validation failure handling -> safe clarification fallback
  it('falls back to a clarification when the AI returns invalid JSON', async () => {
    const planner = new PlannerService(fakeAi('this is not json'));
    const out = await planner.plan(ctx);
    expect(out.needsClarification).toBe(true);
    expect(out.confidence).toBe(0);
    expect(out.actions[0].type).toBe('ask_clarification');
  });

  it('falls back when JSON is valid but violates the schema', async () => {
    const planner = new PlannerService(fakeAi(JSON.stringify({ summary: 123 })));
    const out = await planner.plan(ctx);
    expect(out.needsClarification).toBe(true);
  });

  it('never invents: missing fields stay null in the schema', () => {
    const parsed = plannerOutputSchema.parse(validOutput);
    expect(parsed.detectedProject).toBeNull();
    expect(parsed.actions[0].dueDate).toBeNull();
  });
});
