import { ApprovalService } from '../src/approvals/approval.service';

describe('ApprovalService.classifyResponse', () => {
  const svc = new ApprovalService({} as never, {} as never, {} as never, {} as never);

  // (9) Approval by text
  it('classifies approval words', () => {
    for (const w of ['אשר', 'מאשר', 'כן', 'שלח', 'תבצע']) {
      expect(svc.classifyResponse(w)).toBe('approved');
    }
  });

  // (11) Rejection by text
  it('classifies rejection words', () => {
    for (const w of ['לא', 'אל תשלח', 'בטל', 'לא מאשר', 'עצור']) {
      expect(svc.classifyResponse(w)).toBe('rejected');
    }
  });

  // (10) Ambiguous approval response
  it('classifies ambiguous responses', () => {
    expect(svc.classifyResponse('אולי מחר נראה')).toBe('ambiguous');
    expect(svc.classifyResponse('')).toBe('ambiguous');
  });
});
