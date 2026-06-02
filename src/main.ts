import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { AppLogger } from './logger/logger.service';

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

  await app.listen(config.PORT);
  logger.log(`Work assistant listening on port ${config.PORT}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
