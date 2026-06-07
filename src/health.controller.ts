import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { QueueService } from './queue/queue.service';
import { MigrationRunnerService } from './prisma/migration-runner.service';
import { WebhookRegistrarService } from './whatsapp/webhook-registrar.service';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly webhookRegistrar: WebhookRegistrarService,
    private readonly migrationRunner: MigrationRunnerService,
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
    let dbError: string | null = null;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch (e) {
      db = false;
      // Collapse whitespace/newlines so the real reason shows (no secrets).
      dbError = (e as Error).message.replace(/\s+/g, ' ').trim().slice(0, 300);
    }
    // Did the owner actually set a real DATABASE_URL, or is it the placeholder
    // (which means the variable is still empty/unresolved on the platform)?
    const dbUrl = process.env.DATABASE_URL ?? '';
    const dbConfigured = dbUrl.length > 0 && !dbUrl.includes('invalid:invalid@127.0.0.1');

    // Are the tables actually present? The connection can be healthy (SELECT 1
    // works) while migrations never ran, which makes every real query 500. This
    // probe distinguishes "DB reachable" from "schema deployed".
    let schemaReady: boolean | null = null;
    let schemaError: string | null = null;
    if (db) {
      try {
        const rows = await this.prisma.$queryRaw<{ present: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'WhatsAppMessage'
          ) AS present`;
        schemaReady = rows[0]?.present ?? false;
      } catch (e) {
        schemaError = (e as Error).message.replace(/\s+/g, ' ').trim().slice(0, 300);
      }
    }

    const queue = await this.queue.status();

    const present = (v?: string) => !!v && v.length > 0 && !v.includes('${{');
    return {
      status: db && queue.healthy && schemaReady !== false ? 'ok' : 'degraded',
      ts: new Date().toISOString(),
      subsystems: { database: db, queue: queue.driver, queueHealthy: queue.healthy },
      databaseConfigured: dbConfigured,
      databaseError: dbError,
      schemaReady,
      schemaError,
      migration: this.migrationRunner.getStatus(),
      webhook: this.webhookRegistrar.getStatus(),
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
