import { Module } from '@nestjs/common';
import { GuestsModule } from '../guests/guests.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { BotService } from './bot.service';

@Module({
  imports: [GuestsModule, LoyaltyModule],
  providers: [BotService],
  exports: [BotService],
})
export class BotModule {}
