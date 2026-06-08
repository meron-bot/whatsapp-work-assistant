import type { AiService } from '../src/ai/ai.service';
import type { WebResearchService } from '../src/orchestration/web-research.service';

process.env.DATABASE_URL = 'postgresql://x';

// env() caches on first read, so each test loads a fresh module graph with its
// own WEB_SEARCH_PROVIDER configuration.
function freshService(
  envOverrides: Record<string, string>,
  ai: Partial<AiService> = {},
): WebResearchService {
  let svc!: WebResearchService;
  jest.isolateModules(() => {
    for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
    const { WebResearchService } = require('../src/orchestration/web-research.service');
    svc = new WebResearchService(ai as AiService);
  });
  return svc;
}

describe('WebResearchService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.WEB_SEARCH_PROVIDER;
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    jest.restoreAllMocks();
  });

  it('falls back to assume/ask when no provider is configured', async () => {
    const res = await freshService({ WEB_SEARCH_PROVIDER: 'none' }).research('מה השער של הדולר');
    expect(res).toContain('לא זמין כרגע');
  });

  it('returns "no answer" when the search yields no results', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }) as unknown as typeof fetch;
    const res = await freshService({
      WEB_SEARCH_PROVIDER: 'tavily',
      TAVILY_API_KEY: 'k',
    }).research('שאלה ללא תוצאות');
    expect(res).toContain('לא נמצאה תשובה');
  });

  it('summarises results strictly from sources and appends a source link', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'T', url: 'https://example.com/a', content: 'תוכן רלוונטי' }],
      }),
    }) as unknown as typeof fetch;
    const complete = jest.fn().mockResolvedValue('התשובה הקצרה.');
    const res = await freshService(
      { WEB_SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'k' },
      { complete },
    ).research('שאלה');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].tier).toBe('light');
    expect(res).toContain('התשובה הקצרה.');
    expect(res).toContain('https://example.com/a');
  });

  it('treats a model "no answer" reply as a miss', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ title: 'T', url: 'u', content: 'c' }] }),
    }) as unknown as typeof fetch;
    const complete = jest.fn().mockResolvedValue('לא נמצאה תשובה');
    const res = await freshService(
      { WEB_SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'k' },
      { complete },
    ).research('שאלה');
    expect(res).toContain('לא נמצאה תשובה');
  });
});
