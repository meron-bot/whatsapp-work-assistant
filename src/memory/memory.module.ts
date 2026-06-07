import { Module } from '@nestjs/common';
import { LearnedFactService } from './learned-fact.service';

@Module({
  providers: [LearnedFactService],
  exports: [LearnedFactService],
})
export class MemoryModule {}
