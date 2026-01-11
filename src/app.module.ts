import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BotModule } from './bot/bot.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [BotModule, PrismaModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
