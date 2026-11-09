import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from './api.module';
import { APP_CONFIG } from './config/config.module';
import { AppConfig } from './config/config.schema';

async function bootstrap() {
  const app = await NestFactory.create(ApiModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();

  const cfg = app.get<AppConfig>(APP_CONFIG);
  await app.listen(cfg.PORT);
  Logger.log(`API на :${cfg.PORT} (Syrve: ${cfg.SYRVE_MODE})`, 'Bootstrap');
}

bootstrap().catch((err: Error) => {
  Logger.error(`API не запустився: ${err.message}`, err.stack, 'Bootstrap');
  process.exit(1);
});
