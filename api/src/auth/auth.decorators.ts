import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';
// Маршрут без входа. Всё остальное закрыто глобальным AuthGuard.
export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface SessionAdmin {
  id: string;
  login: string;
}

// Админ текущей сессии (кладёт AuthGuard).
export const CurrentAdmin = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): SessionAdmin => ctx.switchToHttp().getRequest().admin,
);
