import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ClarificationsModule } from '../clarifications/clarifications.module';
import { ContactsModule } from '../contacts/contacts.module';
import { DocumentsModule } from '../documents/documents.module';
import { OpenLoopsModule } from '../open-loops/open-loops.module';
import { RemindersModule } from '../reminders/reminders.module';
import { ActionExecutorService } from './action-executor.service';

@Module({
  imports: [
    ClarificationsModule,
    ApprovalsModule,
    RemindersModule,
    OpenLoopsModule,
    DocumentsModule,
    ContactsModule,
  ],
  providers: [ActionExecutorService],
  exports: [ActionExecutorService],
})
export class ActionsModule {}
