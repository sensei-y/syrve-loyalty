import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentAdmin, SessionAdmin } from '../auth/auth.decorators';
import { SyrveIdPipe } from '../common/syrve-id.pipe';
import { CreateOperationDto } from './dto/create-operation.dto';
import { LoyaltyService } from './loyalty.service';

// Операции привязаны к id гостя в Syrve: гость может быть не привязан к боту.
@Controller('guests/:syrveCustomerId/operations')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  // 200 и итог операции в теле (status: SUCCESS / FAILED / UNKNOWN / PENDING) — FAILED тоже валидный итог.
  @Post()
  @HttpCode(200)
  run(
    @Param('syrveCustomerId', SyrveIdPipe) syrveCustomerId: string,
    @Body() dto: CreateOperationDto,
    @CurrentAdmin() admin: SessionAdmin,
  ) {
    return this.loyalty.run({ ...dto, syrveCustomerId, admin });
  }

  @Get()
  journal(@Param('syrveCustomerId', SyrveIdPipe) syrveCustomerId: string) {
    return this.loyalty.journal(syrveCustomerId);
  }
}
