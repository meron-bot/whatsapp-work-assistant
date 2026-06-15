import { Injectable } from '@nestjs/common';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';
import {
  CompletionOptions,
  TranscriptionResult,
  VisionResult,
} from './ai-provider.interface';
import { AnthropicProvider } from './anthropic.provider';
import { GroqProvider } from './groq.provider';
import { OpenAIProvider } from './openai.provider';

/**
 * Facade that routes each capability to the configured provider. The rest of
 * the app depends on this, not on a concrete vendor.
 */
@Injectable()
export class AiService {
  private readonly logger = new AppLogger('AiService');

  constructor(
    private readonly openai: OpenAIProvider,
    private readonly anthropic: AnthropicProvider,
    private readonly groq: GroqProvider,
  ) {}

  complete(options: CompletionOptions): Promise<string> {
    const provider = env().AI_PLANNER_PROVIDER;
    return provider === 'anthropic'
      ? this.anthropic.complete(options)
      : this.openai.complete(options);
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<TranscriptionResult> {
    // Explicit Groq selection: use it directly.
    if (env().AI_TRANSCRIPTION_PROVIDER === 'groq') {
      return this.groq.transcribe(audio, mimeType);
    }
    // Default: OpenAI, but fall back to Groq (free Whisper) on any failure when a
    // Groq key is configured — so transcription keeps working if OpenAI runs out
    // of quota, instead of degrading to "couldn't transcribe".
    try {
      return await this.openai.transcribe(audio, mimeType);
    } catch (e) {
      if (!this.groq.isConfigured()) throw e;
      this.logger.warn('OpenAI transcription failed; falling back to Groq', {
        error: (e as Error).message,
      });
      return this.groq.transcribe(audio, mimeType);
    }
  }

  describeImage(image: Buffer, mimeType: string): Promise<VisionResult> {
    return this.openai.describeImage(image, mimeType);
  }
}
