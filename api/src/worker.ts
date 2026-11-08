import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BotService } from './bot/bot.service';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  app.get(BotService).start();
  Logger.log('Worker запущено', 'Bootstrap');
}

void bootstrap();
