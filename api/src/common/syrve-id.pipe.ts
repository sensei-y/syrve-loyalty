import { BadRequestException, PipeTransform } from '@nestjs/common';
import { SYRVE_ID_RE } from '../config/config.schema';

// id гостя Syrve в пути запроса. ParseUUIDPipe не подходит: id Syrve не соответствуют RFC 4122.
export class SyrveIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!SYRVE_ID_RE.test(value)) throw new BadRequestException('Невірний ідентифікатор гостя');
    return value;
  }
}
