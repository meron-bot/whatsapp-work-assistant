import { Injectable } from '@nestjs/common';
import { env } from '../config/env';
import {
  CompletionOptions,
  TranscriptionResult,
  VisionResult,
} from './ai-provider.interface';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAIProvider } from './openai.provider';

/**
 * Facade that routes each capability to the configured provider. The rest of
 * the app depends on this, not on a concrete vendor.
 */
@Injectable()
export class AiService {
  constructor(
    private readonly openai: OpenAIProvider,
    private readonly anthropic: AnthropicProvider,
  ) {}

  complete(options: CompletionOptions): Promise<string> {
    const provider = env().AI_PLANNER_PROVIDER;
    return provider === 'anthropic'
      ? this.anthropic.complete(options)
      : this.openai.complete(options);
  }

  transcribe(audio: Buffer, mimeType: string): Promise<TranscriptionResult> {
    return this.openai.transcribe(audio, mimeType);
  }

  describeImage(image: Buffer, mimeType: string): Promise<VisionResult> {
    return this.openai.describeImage(image, mimeType);
  }
}
