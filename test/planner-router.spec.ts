import type { AiService } from '../src/ai/ai.service';
import type { PlannerContextInput } from '../src/planner/planner.prompt';
import { buildRouterSystemPrompt } from '../src/planner/router/planner-router.prompt';
import { PlannerRouterService } from '../src/planner/router/planner-router.service';
import { resolveIntent } from '../src/planner/specialists/specialist.registry';

function ctx(text: string): PlannerContextInput {
  return {
    text,
    transcript: null,
    mediaSummary: null,
    sender: '972500000000',
    timestamp: '2026-06-08T09:00:00.000Z',
    timezone: 'Asia/Jerusalem',
  };
}

function router(complete: jest.Mock): PlannerRouterService {
  return new PlannerRouterService({ complete } as unknown as AiService);
}

describe('buildRouterSystemPrompt — derived from the registry', () => {
  const prompt = buildRouterSystemPrompt();

  it('offers every specialist that has a routerHint', () => {
    expect(prompt).toContain('- schedule:');
    expect(prompt).toContain('- task:');
    expect(prompt).toContain('- document:');
    expect(prompt).toContain('- email:');
    expect(prompt).toContain('- chitchat:');
  });

  it('does NOT offer general (it is the fallback, not an explicit option)', () => {
    expect(prompt).not.toContain('- general:');
  });
});

describe('resolveIntent — when to trust the router vs fall back to general', () => {
  it('falls back to general when there is no route (router disabled)', () => {
    expect(resolveIntent(undefined)).toBe('general');
  });

  it('uses the chosen intent when single-domain and confident', () => {
    expect(resolveIntent({ intent: 'schedule', crossDomain: false, confidence: 0.9 })).toBe(
      'schedule',
    );
  });

  it('falls back to general on a cross-domain message', () => {
    expect(resolveIntent({ intent: 'email', crossDomain: true, confidence: 0.95 })).toBe(
      'general',
    );
  });

  it('falls back to general below the confidence floor', () => {
    expect(resolveIntent({ intent: 'task', crossDomain: false, confidence: 0.4 })).toBe(
      'general',
    );
  });
});

describe('PlannerRouterService.classify — never throws', () => {
  it('parses a valid decision', async () => {
    const complete = jest
      .fn()
      .mockResolvedValue('{"intent":"schedule","crossDomain":false,"confidence":0.8}');
    const decision = await router(complete).classify(ctx('תקבע לי פגישה מחר בעשר'));
    expect(decision).toEqual({ intent: 'schedule', crossDomain: false, confidence: 0.8 });
    expect(complete.mock.calls[0][0].tier).toBe('light');
  });

  it('tolerates markdown-fenced JSON', async () => {
    const complete = jest
      .fn()
      .mockResolvedValue('```json\n{"intent":"email","crossDomain":false,"confidence":0.7}\n```');
    const decision = await router(complete).classify(ctx('תשלח מייל ליוסי'));
    expect(decision.intent).toBe('email');
  });

  it('falls back to general when the model errors', async () => {
    const complete = jest.fn().mockRejectedValue(new Error('boom'));
    const decision = await router(complete).classify(ctx('משהו'));
    expect(decision).toEqual({ intent: 'general', crossDomain: false, confidence: 0 });
  });

  it('falls back to general on unparseable output', async () => {
    const complete = jest.fn().mockResolvedValue('not json at all');
    const decision = await router(complete).classify(ctx('משהו'));
    expect(decision.intent).toBe('general');
  });

  it('falls back to general when JSON is missing a required field', async () => {
    const complete = jest.fn().mockResolvedValue('{"intent":"schedule"}');
    const decision = await router(complete).classify(ctx('משהו'));
    expect(decision.intent).toBe('general');
  });
});
