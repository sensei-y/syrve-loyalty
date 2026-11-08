import { Global, Module } from '@nestjs/common';
import { AppConfig, loadConfig } from './config.schema';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
