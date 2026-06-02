import { Module } from '@nestjs/common';
import { DocumentAgentService } from './document-agent.service';

@Module({
  providers: [DocumentAgentService],
  exports: [DocumentAgentService],
})
export class DocumentsModule {}
