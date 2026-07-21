import { Module } from '@nestjs/common';
import { ClarificationsModule } from '../clarifications/clarifications.module';
import { FlightSearchClient } from '../flights/flight-search.client';
import { ShabbatCalendar } from '../flights/shabbat';
import { RemindersModule } from '../reminders/reminders.module';
import { DailyPlanningService } from './daily-planning.service';
import { EmailTriageService } from './email-triage.service';
import { FlightWatchService } from './flight-watch.service';
import { MeetingPrepService } from './meeting-prep.service';
import { MorningEmailReviewService } from './morning-email-review.service';

@Module({
  imports: [RemindersModule, ClarificationsModule],
  providers: [
    DailyPlanningService,
    EmailTriageService,
    MeetingPrepService,
    MorningEmailReviewService,
    FlightSearchClient,
    ShabbatCalendar,
    FlightWatchService,
  ],
})
export class SchedulerModule {}
