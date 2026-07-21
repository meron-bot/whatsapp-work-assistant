import { Module } from '@nestjs/common';
import { ClarificationsModule } from '../clarifications/clarifications.module';
import { RemindersModule } from '../reminders/reminders.module';
import { DailyPlanningService } from './daily-planning.service';
import { EmailTriageService } from './email-triage.service';
import { MeetingPrepService } from './meeting-prep.service';
import { MorningEmailReviewService } from './morning-email-review.service';

@Module({
  imports: [RemindersModule, ClarificationsModule],
  providers: [
    DailyPlanningService,
    EmailTriageService,
    MeetingPrepService,
    MorningEmailReviewService,
  ],
})
export class SchedulerModule {}
