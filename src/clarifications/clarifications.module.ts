import { Module } from '@nestjs/common';
import { OpenLoopsModule } from '../open-loops/open-loops.module';
import { ClarificationService } from './clarification.service';

@Module({
  imports: [OpenLoopsModule],
  providers: [ClarificationService],
  exports: [ClarificationService],
})
export class ClarificationsModule {}
