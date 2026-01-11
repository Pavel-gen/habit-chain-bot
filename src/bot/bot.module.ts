import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  providers: [BotService],
  imports: [PrismaModule]
})
export class BotModule {}
