import { Module } from '@nestjs/common';
import { OpenLoopsModule } from '../open-loops/open-loops.module';
import { ApprovalService } from './approval.service';

@Module({
  imports: [OpenLoopsModule],
  providers: [ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalsModule {}
