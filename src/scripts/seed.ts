import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../config/env';

/**
 * Idempotently create the single owner User from the configured environment.
 * Safe to run on every deploy.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = new PrismaClient();
  try {
    await prisma.user.upsert({
      where: { whatsappNumber: env.OWNER_WHATSAPP_NUMBER },
      create: {
        name: 'Owner',
        whatsappNumber: env.OWNER_WHATSAPP_NUMBER,
        timezone: env.OWNER_TIMEZONE,
        language: env.OWNER_LANGUAGE,
      },
      update: { timezone: env.OWNER_TIMEZONE, language: env.OWNER_LANGUAGE },
    });
    // eslint-disable-next-line no-console
    console.log(`[seed] owner ${env.OWNER_WHATSAPP_NUMBER} ready`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[seed] failed:', e);
  process.exit(1);
});
