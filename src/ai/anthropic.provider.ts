import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { CompletionOptions, TextCompletionProvider } from './ai-provider.interface';

/**
 * Anthropic/Claude provider for planning and document drafting. Vision and
 * transcription are delegated to OpenAI in this MVP.
 */
@Injectable()
export class AnthropicProvider implements TextCompletionProvider {
  private readonly client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
  }

  async complete(options: CompletionOptions): Promise<string> {
    const messages: Anthropic.MessageParam[] = options.messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    // JSON mode: instruct via system/user text (assistant prefill is not
    // supported by all models). The planner parses the JSON object robustly.
    const system = options.jsonMode
      ? `${options.system ?? ''}\n\nRespond with ONLY a single valid JSON object. No markdown, no prose, no code fences.`.trim()
      : options.system;

    const model =
      options.tier === 'light' ? env().ANTHROPIC_MODEL_LIGHT : env().ANTHROPIC_MODEL_HEAVY;

    const res = await this.client.messages.create({
      model,
      max_tokens: options.maxTokens ?? 2000,
      temperature: options.temperature ?? 0,
      system,
      messages,
    });

    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }
}
