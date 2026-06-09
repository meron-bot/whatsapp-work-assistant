import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { MemoryModule } from '../memory/memory.module';
import { OrchestrationService } from './orchestration.service';
import { WebResearchService } from './web-research.service';

/**
 * The sub-agent / tool layer the planner can invoke to resolve context before
 * asking the owner. Google services are provided globally; memory + contacts are
 * imported so discovered contacts can be remembered and reused.
 */
@Module({
  imports: [MemoryModule, ContactsModule],
  providers: [OrchestrationService, WebResearchService],
  exports: [OrchestrationService],
})
export class OrchestrationModule {}
