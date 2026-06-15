import { Global, Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AnthropicProvider } from './anthropic.provider';
import { GroqProvider } from './groq.provider';
import { OpenAIProvider } from './openai.provider';

@Global()
@Module({
  providers: [OpenAIProvider, AnthropicProvider, GroqProvider, AiService],
  exports: [AiService, OpenAIProvider, AnthropicProvider, GroqProvider],
})
export class AiModule {}
