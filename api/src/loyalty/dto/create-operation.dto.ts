import { OpType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsNumber, IsPositive, IsString, IsUUID, Length, Max } from 'class-validator';

export const MAX_OPERATION_AMOUNT = 100_000;

export class CreateOperationDto {
  // Генерирует форма при открытии; повтор с тем же ключом = тот же запрос.
  @IsUUID()
  idempotencyKey: string;

  @IsEnum(OpType)
  type: OpType;

  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false }, { message: 'Сума — до 2 знаків після коми' })
  @IsPositive({ message: 'Сума має бути більшою за 0' })
  @Max(MAX_OPERATION_AMOUNT, { message: `Сума не більша за ${MAX_OPERATION_AMOUNT}` })
  amount: number;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(3, 200, { message: 'Причина — від 3 до 200 символів' })
  reason: string;
}
