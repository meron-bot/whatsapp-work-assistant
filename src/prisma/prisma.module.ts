import { Global, Module } from '@nestjs/common';
import { MigrationRunnerService } from './migration-runner.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, MigrationRunnerService],
  exports: [PrismaService, MigrationRunnerService],
})
export class PrismaModule {}
