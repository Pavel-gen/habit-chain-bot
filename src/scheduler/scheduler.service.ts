// src/scheduler/scheduler.service.ts
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import cron from 'node-cron';
import { BotService } from 'src/bot/bot.service'; // Ссылка для отправки

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(private botService: BotService) {}

  onModuleInit() {
    // Запуск каждые 4 часа с 9 до 23
    cron.schedule('0 9-23/3 * * *', async () => {
      this.logger.log('Запуск задачи опроса состояния...');
      try {
        await this.botService.sendStateCheckToAllActiveUsers();
      } catch (error) {
        this.logger.error('Ошибка в крон-задаче', error);
      }
    });
  }
}
