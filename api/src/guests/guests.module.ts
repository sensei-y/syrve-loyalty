import { Module } from '@nestjs/common';
import { GuestsService } from './guests.service';

@Module({
  providers: [GuestsService],
  exports: [GuestsService],
})
export class GuestsModule {}
