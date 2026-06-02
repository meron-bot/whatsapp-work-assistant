import { Module } from '@nestjs/common';
import { OpenLoopService } from './open-loop.service';

@Module({
  providers: [OpenLoopService],
  exports: [OpenLoopService],
})
export class OpenLoopsModule {}
