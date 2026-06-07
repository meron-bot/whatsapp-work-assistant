import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { OrchestrationService } from './orchestration.service';

/**
 * The sub-agent / tool layer the planner can invoke to resolve context before
 * asking the owner. Google services are provided globally; memory is imported so
 * discovered contacts can be remembered.
 */
@Module({
  imports: [MemoryModule],
  providers: [OrchestrationService],
  exports: [OrchestrationService],
})
export class OrchestrationModule {}
