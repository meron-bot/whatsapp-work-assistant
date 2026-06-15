import { Module } from '@nestjs/common';
import { ClarificationsModule } from '../clarifications/clarifications.module';
import { RemindersModule } from '../reminders/reminders.module';
import { DailyPlanningService } from './daily-planning.service';
import { EmailTriageService } from './email-triage.service';
import { MeetingPrepService } from './meeting-prep.service';

@Module({
  imports: [RemindersModule, ClarificationsModule],
  providers: [DailyPlanningService, EmailTriageService, MeetingPrepService],
})
export class SchedulerModule {}
