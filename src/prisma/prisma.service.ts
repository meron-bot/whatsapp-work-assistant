import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppLogger } from '../logger/logger.service';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new AppLogger('PrismaService');

  async onModuleInit(): Promise<void> {
    // Do not crash the whole app if the DB is briefly unreachable at boot —
    // Prisma connects lazily on first query anyway, and we want the HTTP server
    // (and /status diagnostics) to come up regardless.
    try {
      await this.$connect();
    } catch (e) {
      this.logger.error('Initial DB connection failed (will retry lazily)', {
        error: (e as Error).message,
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
