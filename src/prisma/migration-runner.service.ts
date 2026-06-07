import { Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { AppLogger } from '../logger/logger.service';

/** Last in-process migration outcome, surfaced at /status for browser diagnosis. */
export interface MigrationStatus {
  ran: boolean;
  ok: boolean | null;
  output: string | null;
  ranAt: string | null;
}

/**
 * Runs `prisma migrate deploy` from inside the Node process on startup, as a
 * backstop to the shell entrypoint. The entrypoint runs the same command but its
 * output is only visible in platform logs; here we capture stdout/stderr and the
 * exit result and expose them at /status, so a failed migration is diagnosable
 * from the browser. Never throws — the app keeps running regardless.
 */
@Injectable()
export class MigrationRunnerService {
  private readonly logger = new AppLogger('MigrationRunner');

  private status: MigrationStatus = {
    ran: false,
    ok: null,
    output: null,
    ranAt: null,
  };

  getStatus(): MigrationStatus {
    return this.status;
  }

  async runMigrations(): Promise<void> {
    this.status.ran = true;
    this.status.ranAt = new Date().toISOString();

    await new Promise<void>((resolve) => {
      execFile(
        'npx',
        ['prisma', 'migrate', 'deploy'],
        { timeout: 120_000, env: process.env, shell: process.platform === 'win32' },
        (err, stdout, stderr) => {
          const output = `${stdout ?? ''}\n${stderr ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 1000);
          this.status.output = output;
          if (err) {
            this.status.ok = false;
            this.logger.error('Migrations failed (non-fatal)', { output });
          } else {
            this.status.ok = true;
            this.logger.log('Migrations applied', { output });
          }
          resolve();
        },
      );
    });
  }
}
