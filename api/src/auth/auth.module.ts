import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';
import { AuthController, SESSION_TTL_MS } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        secret: cfg.JWT_SECRET,
        signOptions: { expiresIn: SESSION_TTL_MS / 1000 },
      }),
    }),
  ],
  controllers: [AuthController],
  // Guard глобальный: новый контроллер закрыт по умолчанию, открыть можно только явно через @Public().
  providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
