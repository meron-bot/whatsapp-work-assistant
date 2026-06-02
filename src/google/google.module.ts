import { Global, Module } from '@nestjs/common';
import { GoogleAuthController } from './google-auth.controller';
import { GoogleAuthService } from './google-auth.service';
import { GoogleCalendarService } from './google-calendar.service';
import { GoogleDocsService } from './google-docs.service';
import { GoogleDriveService } from './google-drive.service';
import { GoogleGmailService } from './google-gmail.service';
import { GoogleTasksService } from './google-tasks.service';

@Global()
@Module({
  controllers: [GoogleAuthController],
  providers: [
    GoogleAuthService,
    GoogleCalendarService,
    GoogleTasksService,
    GoogleDriveService,
    GoogleDocsService,
    GoogleGmailService,
  ],
  exports: [
    GoogleAuthService,
    GoogleCalendarService,
    GoogleTasksService,
    GoogleDriveService,
    GoogleDocsService,
    GoogleGmailService,
  ],
})
export class GoogleModule {}
