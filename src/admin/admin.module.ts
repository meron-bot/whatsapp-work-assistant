import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminAuthGuard } from './admin-auth.guard';

@Module({
  controllers: [AdminController],
  providers: [AdminAuthGuard],
})
export class AdminModule {}
