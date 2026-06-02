import { Module } from '@nestjs/common';
import { ClarificationService } from './clarification.service';

@Module({
  providers: [ClarificationService],
  exports: [ClarificationService],
})
export class ClarificationsModule {}
