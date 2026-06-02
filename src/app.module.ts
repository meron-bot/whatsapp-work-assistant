import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from './admin/admin.module';
import { AiModule } from './ai/ai.module';
import { GoogleModule } from './google/google.module';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { SharedModule } from './shared/shared.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    QueueModule,
    AiModule,
    GoogleModule,
    SharedModule,
    WhatsAppModule,
    SchedulerModule,
    AdminModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
