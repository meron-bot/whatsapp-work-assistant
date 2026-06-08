import { Module } from '@nestjs/common';
import { PlannerService } from './planner.service';
import { PlannerRouterService } from './router/planner-router.service';

@Module({
  providers: [PlannerService, PlannerRouterService],
  exports: [PlannerService, PlannerRouterService],
})
export class PlannerModule {}
