import { Injectable } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';

/** A single search hit, normalised across providers. */
interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Real web_research sub-agent. Runs a web search (Brave or Tavily), takes the
 * top few results, and asks the model to answer the question STRICTLY from those
 * sources — no invention. Returns a short Hebrew finding plus a source link, or
 * "no answer found" if the sources don't cover it. This mirrors gmailSearch:
 * a miss is a finding the planner reacts to, never a crash.
 *
 * If no provider/key is configured it returns the old graceful fallback so the
 * planner keeps working (assume / ask).
 */
@Injectable()
export class WebResearchService {
  private readonly logger = new AppLogger('WebResearch');

  constructor(private readonly ai: AiService) {}

  async research(question: string): Promise<string> {
    const q = (question || '').trim();
    if (!q) return '[web_research] שאלה ריקה.';

    const provider = env().WEB_SEARCH_PROVIDER;
    if (provider === 'none') {
      return `[web_research "${q}"] לא זמין כרגע — הסתמך על הקשר, הנח הנחה סבירה, או שאל את מירון.`;
    }

    const hits =
      provider === 'brave' ? await this.searchBrave(q) : await this.searchTavily(q);
    if (!hits.length) return `[web_research "${q}"] לא נמצאה תשובה.`;

    const sources = hits
      .map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.snippet}`)
      .join('\n\n');

    const answer = await this.ai.complete({
      tier: 'light',
      temperature: 0,
      maxTokens: 400,
      system:
        'אתה עוזר מחקר. ענה על השאלה אך ורק על סמך המקורות שסופקו. ' +
        'אל תמציא עובדות שאינן מופיעות במקורות. אם המקורות אינם עונים על השאלה, ' +
        'החזר בדיוק "לא נמצאה תשובה". ענה בעברית, בקצרה (2-3 משפטים).',
      messages: [
        { role: 'user', content: `שאלה: ${q}\n\nמקורות:\n${sources}` },
      ],
    });

    const trimmed = answer.trim();
    if (!trimmed || trimmed.includes('לא נמצאה תשובה')) {
      return `[web_research "${q}"] לא נמצאה תשובה.`;
    }
    return `[web_research "${q}"] ${trimmed}\nמקור: ${hits[0].url}`;
  }

  private async searchBrave(query: string): Promise<SearchHit[]> {
    const key = env().BRAVE_SEARCH_API_KEY;
    if (!key) {
      this.logger.warn('WEB_SEARCH_PROVIDER=brave but BRAVE_SEARCH_API_KEY is empty');
      return [];
    }
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
      query,
    )}&count=5`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    });
    if (!res.ok) {
      throw new Error(`Brave search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      web?: { results?: { title?: string; url?: string; description?: string }[] };
    };
    return (data.web?.results ?? []).slice(0, 5).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
    }));
  }

  private async searchTavily(query: string): Promise<SearchHit[]> {
    const key = env().TAVILY_API_KEY;
    if (!key) {
      this.logger.warn('WEB_SEARCH_PROVIDER=tavily but TAVILY_API_KEY is empty');
      return [];
    }
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: 5 }),
    });
    if (!res.ok) {
      throw new Error(`Tavily search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      results?: { title?: string; url?: string; content?: string }[];
    };
    return (data.results ?? []).slice(0, 5).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
    }));
  }
}
