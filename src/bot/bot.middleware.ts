// src/bot/bot.middleware.ts
import { MyContext } from './interfaces';
import { Logger } from '@nestjs/common';

const logger = new Logger('BotMiddleware');

export const errorMiddleware = async (
  ctx: MyContext,
  next: () => Promise<void>,
) => {
  try {
    await next();
  } catch (error) {
    logger.error(`Ошибка в чате ${ctx.chat?.id}:`, error);
    // Не даем ошибке упасть дальше, но сообщаем пользователю
    if (ctx.chat) {
      await ctx.reply(
        '⚠️ Произошла внутренняя ошибка. Я уже чиню. Попробуйте позже.',
      );
    }
  }
};
