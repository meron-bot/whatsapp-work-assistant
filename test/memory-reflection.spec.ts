import { MemoryReflectionService } from '../src/memory/memory-reflection.service';

function make(complete: jest.Mock, facts: any[]) {
  const ai = { complete } as any;
  const memory = {
    listActive: jest.fn().mockResolvedValue(facts),
    deactivate: jest.fn().mockResolvedValue(0),
  } as any;
  return { svc: new MemoryReflectionService(ai, memory), ai, memory };
}

const FACTS = [
  { id: 'f1', type: 'contact', subject: 'דנה', content: 'דנה: dana@x.com' },
  { id: 'f2', type: 'contact', subject: 'דנה', content: 'דנה: dana@x.com' }, // duplicate
];

describe('MemoryReflectionService', () => {
  it('does nothing (no AI call) with fewer than two facts', async () => {
    const complete = jest.fn();
    const { svc, memory } = make(complete, [FACTS[0]]);
    expect(await svc.reflect()).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(memory.deactivate).not.toHaveBeenCalled();
  });

  it('deactivates only ids the model returned that actually exist', async () => {
    const complete = jest.fn().mockResolvedValue(
      JSON.stringify({ deactivate: [{ id: 'f2', reason: 'duplicate' }, { id: 'ghost', reason: 'x' }] }),
    );
    const { svc, memory } = make(complete, FACTS);
    memory.deactivate.mockResolvedValue(1);
    const n = await svc.reflect();
    expect(memory.deactivate).toHaveBeenCalledWith(['f2']); // 'ghost' filtered out
    expect(n).toBe(1);
  });

  it('never throws — a model/parse failure leaves memory untouched', async () => {
    const complete = jest.fn().mockResolvedValue('not json at all');
    const { svc, memory } = make(complete, FACTS);
    expect(await svc.reflect()).toBe(0);
    expect(memory.deactivate).not.toHaveBeenCalled();
  });
});
