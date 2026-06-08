import { Module } from '@nestjs/common';
import { ClarificationsModule } from '../clarifications/clarifications.module';
import { RemindersModule } from '../reminders/reminders.module';
import { DailyPlanningService } from './daily-planning.service';

@Module({
  imports: [RemindersModule, ClarificationsModule],
  providers: [DailyPlanningService],
})
export class SchedulerModule {}
