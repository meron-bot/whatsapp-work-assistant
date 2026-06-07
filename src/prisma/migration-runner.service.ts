import { Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { AppLogger } from '../logger/logger.service';
import { PrismaService } from './prisma.service';

/** Last in-process migration outcome, surfaced at /status for browser diagnosis. */
export interface MigrationStatus {
  ran: boolean;
  ok: boolean | null;
  output: string | null;
  ranAt: string | null;
  recovered: boolean;
}

/**
 * Runs `prisma migrate deploy` from inside the Node process on startup, as a
 * backstop to the shell entrypoint. The entrypoint runs the same command but its
 * output is only visible in platform logs; here we capture stdout/stderr and the
 * exit result and expose them at /status, so a failed migration is diagnosable
 * from the browser. Never throws — the app keeps running regardless.
 *
 * Self-heals the P3005 case ("schema is not empty" with no migration history):
 * when the core table is absent — i.e. the schema holds only leftover junk from a
 * previously interrupted init and there is no real data — it drops and recreates
 * the public schema, then re-applies migrations. Strictly guarded so it can never
 * wipe a schema that actually contains the application's tables.
 */
@Injectable()
export class MigrationRunnerService {
  private readonly logger = new AppLogger('MigrationRunner');

  constructor(private readonly prisma: PrismaService) {}

  private status: MigrationStatus = {
    ran: false,
    ok: null,
    output: null,
    ranAt: null,
    recovered: false,
  };

  getStatus(): MigrationStatus {
    return this.status;
  }

  async runMigrations(): Promise<void> {
    this.status.ran = true;
    this.status.ranAt = new Date().toISOString();

    let result = await this.deploy();

    // Recover from an inconsistent, data-free schema (interrupted prior init).
    if (!result.ok && /P3005/.test(result.output) && (await this.coreTableMissing())) {
      this.logger.warn('P3005 with no application schema; resetting public schema and retrying');
      try {
        await this.resetPublicSchema();
        this.status.recovered = true;
        result = await this.deploy();
      } catch (e) {
        result = { ok: false, output: `schema reset failed: ${(e as Error).message}`.slice(0, 1000) };
      }
    }

    this.status.ok = result.ok;
    this.status.output = result.output;
    if (result.ok) {
      this.logger.log('Migrations applied', { output: result.output });
    } else {
      this.logger.error('Migrations failed (non-fatal)', { output: result.output });
    }
  }

  /** Run `prisma migrate deploy`, capturing combined output and exit result. */
  private deploy(): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      execFile(
        'npx',
        ['prisma', 'migrate', 'deploy'],
        { timeout: 120_000, env: process.env, shell: process.platform === 'win32' },
        (err, stdout, stderr) => {
          const output = `${stdout ?? ''}\n${stderr ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 1000);
          resolve({ ok: !err, output });
        },
      );
    });
  }

  /** True when the application's core table does not exist (schema has no data). */
  private async coreTableMissing(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'WhatsAppMessage'
      ) AS present`;
    return !(rows[0]?.present ?? false);
  }

  /** Drop and recreate the public schema. Only called once the guard above holds. */
  private async resetPublicSchema(): Promise<void> {
    await this.prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await this.prisma.$executeRawUnsafe('CREATE SCHEMA public');
  }
}
