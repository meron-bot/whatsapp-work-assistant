import { Module } from '@nestjs/common';
import { RemindersModule } from '../reminders/reminders.module';
import { DailyPlanningService } from './daily-planning.service';

@Module({
  imports: [RemindersModule],
  providers: [DailyPlanningService],
})
export class SchedulerModule {}
