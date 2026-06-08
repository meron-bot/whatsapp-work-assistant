import { Module } from '@nestjs/common';
import { LearnedFactService } from './learned-fact.service';
import { MemoryReflectionService } from './memory-reflection.service';

@Module({
  providers: [LearnedFactService, MemoryReflectionService],
  exports: [LearnedFactService],
})
export class MemoryModule {}
