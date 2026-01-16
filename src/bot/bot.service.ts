import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Telegraf, Context, session } from 'telegraf';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { message } from 'telegraf/filters';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private bot: Telegraf<Context>;
  private logger = new Logger(BotService.name);
  private SYSTEM_PROMPT: string;

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not defined in .env');
    }
    this.bot = new Telegraf(token);
  }

  async onModuleInit() {
    // Поддержка сессий (даже если не используем — нужна для контекста)
    this.bot.use(session());
    const promptPath = path.join(
      process.cwd(),
      'src',
      'llm',
      'prompts',
      'DBTpromt1.txt',
    );
    this.SYSTEM_PROMPT = fs.readFileSync(promptPath, 'utf-8').trim();

    // Команда /start
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        'Привет! Отправь мне любое сообщение, и я обработаю его через ИИ.',
      );
    });

    // Обработка всех текстовых сообщений
    this.bot.on(message('text'), async (ctx) => {
      const userMessage = ctx.message.text;

      try {
        const aiResponse = await this.callOpenRouter(userMessage);
        await this.sendLongMessage(ctx, aiResponse, ctx.message.message_id);
      } catch (error) {
        this.logger.error('Ошибка при вызове OpenRouter:', error);
        await ctx.reply(
          '⚠️ Произошла ошибка при обработке запроса. Попробуйте позже.',
        );
      }
    });

    // Запуск бота
    try {
      await this.bot.launch();
      this.logger.log('✅ Telegram bot запущен!');
    } catch (error) {
      this.logger.error('❌ Ошибка при запуске Telegram бота:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.bot.stop('SIGTERM');
  }

  private async sendLongMessage(
    ctx: Context,
    text: string,
    replyToId?: number,
  ) {
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await ctx.reply(text);
      return;
    }

    // Разбиваем на части, стараясь не резать слова
    let start = 0;
    while (start < text.length) {
      let end = start + MAX_LENGTH;

      // Если не последняя часть — пытаемся найти ближайший перенос строки или пробел
      if (end < text.length) {
        const lastNewline = text.lastIndexOf('\n', end);
        const lastSpace = text.lastIndexOf(' ', end);
        const cutPoint = Math.max(lastNewline, lastSpace);
        if (cutPoint > start) {
          end = cutPoint;
        }
      }

      const chunk = text.slice(start, end).trim();
      await ctx.reply(chunk);
      start = end;
    }
  }

  private async callOpenRouter(userMessage: string): Promise<string> {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY is not defined in .env');
    }

    // 🔁 Твой фиксированный промпт
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'nex-agi/deepseek-v3.1-nex-n1', // или любой другой бесплатный/платный
          messages: [
            { role: 'system', content: this.SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          max_tokens: 1000,
        },
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'http://localhost', // обязательно для OpenRouter
            'X-Title': 'My Telegram AI Bot',
            'Content-Type': 'application/json',
          },
        },
      );

      const aiText = response.data.choices[0]?.message?.content?.trim();
      if (!aiText) {
        throw new Error('Пустой ответ от OpenRouter');
      }
      return aiText;
    } catch (err) {
      this.logger.error(`Ошибка при запросе ${err.message}`);
      return '';
    }
  }
}
