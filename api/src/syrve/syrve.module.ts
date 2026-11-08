import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';
import { MockSyrveClient } from './mock-syrve.client';
import { RealSyrveClient } from './real-syrve.client';
import { SYRVE_CLIENT, SyrveClient } from './syrve-client.interface';

// Реализация выбирается через DI по SYRVE_MODE — как подмена репозитория в Hilt.
@Global()
@Module({
  providers: [
    {
      provide: SYRVE_CLIENT,
      useFactory: (cfg: AppConfig): SyrveClient =>
        cfg.SYRVE_MODE === 'real' ? new RealSyrveClient(cfg) : new MockSyrveClient(),
      inject: [APP_CONFIG],
    },
  ],
  exports: [SYRVE_CLIENT],
})
export class SyrveModule {}
