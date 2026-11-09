import { BadRequestException, Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { normalizePhone } from '../common/phone';
import { SyrveIdPipe } from '../common/syrve-id.pipe';
import { GuestsService } from './guests.service';

@Controller('guests')
export class GuestsController {
  constructor(private readonly guests: GuestsService) {}

  // GET /api/guests?phone=0991234567 — поиск по телефону среди всех гостей Syrve.
  @Get()
  async search(@Query('phone') rawPhone = '') {
    const phone = normalizePhone(rawPhone);
    if (!phone) throw new BadRequestException('Невірний номер телефону. Формат: +380XXXXXXXXX');
    return (await this.guests.getProfile({ phone })) ?? notFound();
  }

  // Свежие данные гостя (после операции — обновить баланс).
  @Get(':syrveCustomerId')
  async get(@Param('syrveCustomerId', SyrveIdPipe) id: string) {
    return (await this.guests.getProfile({ id })) ?? notFound();
  }
}

function notFound(): never {
  throw new NotFoundException('Гостя з таким номером не знайдено в Syrve');
}
