import { Global, Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAIProvider } from './openai.provider';

@Global()
@Module({
  providers: [OpenAIProvider, AnthropicProvider, AiService],
  exports: [AiService, OpenAIProvider, AnthropicProvider],
})
export class AiModule {}
