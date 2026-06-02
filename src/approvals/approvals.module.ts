import { Module } from '@nestjs/common';
import { ApprovalService } from './approval.service';

@Module({
  providers: [ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalsModule {}
