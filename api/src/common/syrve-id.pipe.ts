import { BadRequestException, PipeTransform } from '@nestjs/common';
import { SYRVE_ID_RE } from '../config/config.schema';

// id гостя Syrve в пути запроса. ParseUUIDPipe не подходит: id Syrve не соответствуют RFC 4122.
// Регистр приводим к нижнему: Syrve принимает id в любом регистре (проверено) и возвращает в нижнем,
// а у нас id — ключ очереди операций и журнала: `ABC…` и `abc…` — один гость.
export class SyrveIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!SYRVE_ID_RE.test(value)) throw new BadRequestException('Невірний ідентифікатор гостя');
    return value.toLowerCase();
  }
}
