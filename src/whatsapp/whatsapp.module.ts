import { Module, OnModuleInit } from '@nestjs/common';
import { ActionsModule } from '../actions/actions.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ClarificationsModule } from '../clarifications/clarifications.module';
import { MediaModule } from '../media/media.module';
import { PlannerModule } from '../planner/planner.module';
import { MessageProcessorService } from '../processing/message-processor.service';
import { QueueService } from '../queue/queue.service';
import { WhatsAppController } from './whatsapp.controller';
import { WebhookRegistrarService } from './webhook-registrar.service';

@Module({
  imports: [
    MediaModule,
    PlannerModule,
    ActionsModule,
    ClarificationsModule,
    ApprovalsModule,
  ],
  controllers: [WhatsAppController],
  providers: [MessageProcessorService, WebhookRegistrarService],
  exports: [WebhookRegistrarService],
})
export class WhatsAppModule implements OnModuleInit {
  constructor(
    private readonly queue: QueueService,
    private readonly processor: MessageProcessorService,
  ) {}

  /** Wire the queue worker to the processor after DI is ready. */
  onModuleInit(): void {
    this.queue.registerMessageHandler(async (job) => {
      await this.processor.process(job.whatsappMessageId);
    });
  }
}
