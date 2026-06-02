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

    // For JSON mode we prefill the assistant turn with "{" to force a JSON object.
    if (options.jsonMode) {
      messages.push({ role: 'assistant', content: '{' });
    }

    const res = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: options.maxTokens ?? 2000,
      temperature: options.temperature ?? 0,
      system: options.system,
      messages,
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return options.jsonMode ? `{${text}` : text;
  }
}
