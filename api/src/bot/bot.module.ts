import { Module } from '@nestjs/common';
import { GuestsModule } from '../guests/guests.module';
import { BotService } from './bot.service';

@Module({
  imports: [GuestsModule],
  providers: [BotService],
  exports: [BotService],
})
export class BotModule {}
