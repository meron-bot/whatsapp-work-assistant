import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { env } from '../config/env';

export interface StoredFile {
  storagePath: string;
  publicUrl: string | null;
}

/**
 * Storage abstraction. Local filesystem for development; for production the
 * Drive/S3 providers can be added behind the same interface. Originals are
 * always preserved (anti-hallucination: keep source material).
 */
@Injectable()
export class StorageService {
  async save(buffer: Buffer, filename: string, subdir = 'media'): Promise<StoredFile> {
    if (env().STORAGE_PROVIDER === 'local') {
      const dir = path.resolve(env().LOCAL_STORAGE_PATH, subdir);
      await fs.mkdir(dir, { recursive: true });
      const full = path.join(dir, filename);
      await fs.writeFile(full, buffer);
      return { storagePath: full, publicUrl: null };
    }
    // Drive / S3 providers would be implemented here for production.
    throw new Error(`Storage provider ${env().STORAGE_PROVIDER} not implemented in MVP`);
  }
}
