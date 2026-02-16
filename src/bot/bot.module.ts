import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { LlmService } from 'src/llm/llm.service';
import { DatabaseService } from 'src/database/database.service';
import { SchedulerService } from 'src/scheduler/scheduler.service';
import { PrismaService } from 'src/prisma/prisma.service';

@Module({
  providers: [
    BotService,
    LlmService,
    DatabaseService,
    SchedulerService,
    PrismaService,
  ],
  imports: [PrismaModule],
})
export class BotModule {}
