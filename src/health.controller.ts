import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { QueueService } from './queue/queue.service';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Liveness — always 200 if the process is up (used by the platform healthcheck). */
  @Get('health')
  health() {
    return { status: 'ok', ts: new Date().toISOString() };
  }

  /**
   * Diagnostics — reports which subsystems are actually connected and which env
   * vars are present (booleans only, never values). Open this in a browser to
   * see exactly what is misconfigured without reading server logs.
   */
  @Get('status')
  async status() {
    let db = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch {
      db = false;
    }
    const redis = await this.queue.checkRedis();

    const present = (v?: string) => !!v && v.length > 0 && !v.includes('${{');
    return {
      status: db && redis ? 'ok' : 'degraded',
      ts: new Date().toISOString(),
      subsystems: { database: db, redis },
      config: {
        DATABASE_URL: present(process.env.DATABASE_URL),
        REDIS_URL: present(process.env.REDIS_URL),
        OWNER_WHATSAPP_NUMBER: present(process.env.OWNER_WHATSAPP_NUMBER),
        WHATSAPP_ACCESS_TOKEN: present(process.env.WHATSAPP_ACCESS_TOKEN),
        WHATSAPP_PHONE_NUMBER_ID: present(process.env.WHATSAPP_PHONE_NUMBER_ID),
        WHATSAPP_VERIFY_TOKEN: present(process.env.WHATSAPP_VERIFY_TOKEN),
        META_APP_ID: present(process.env.META_APP_ID),
        META_APP_SECRET: present(process.env.META_APP_SECRET),
        ANTHROPIC_API_KEY: present(process.env.ANTHROPIC_API_KEY),
        OPENAI_API_KEY: present(process.env.OPENAI_API_KEY),
        APP_BASE_URL: present(process.env.APP_BASE_URL),
      },
    };
  }
}
