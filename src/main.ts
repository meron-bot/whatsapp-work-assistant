import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config(); // load .env before env validation

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { AppLogger } from './logger/logger.service';
import { WebhookRegistrarService } from './whatsapp/webhook-registrar.service';

async function bootstrap(): Promise<void> {
  // Fail fast if the environment is misconfigured.
  const config = loadEnv();
  const logger = new AppLogger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new AppLogger('Nest'),
    // Capture the raw body so we can verify the WhatsApp webhook signature.
    rawBody: true,
    bodyParser: true,
  });

  // Preserve raw body bytes for HMAC verification.
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );

  // Bind explicitly to 0.0.0.0 so the platform proxy/healthcheck can reach us.
  await app.listen(config.PORT, '0.0.0.0');
  logger.log(`Work assistant listening on 0.0.0.0:${config.PORT}`);

  // Self-register the WhatsApp webhook with Meta (no manual dashboard step).
  // Runs after the server is listening so Meta's verification GET succeeds.
  try {
    await app.get(WebhookRegistrarService, { strict: false }).registerIfConfigured();
  } catch (err) {
    logger.error('Webhook auto-registration error (non-fatal)', {
      error: (err as Error).message,
    });
  }
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
