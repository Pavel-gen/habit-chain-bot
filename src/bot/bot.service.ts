import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Telegraf, Context, session } from 'telegraf';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { message } from 'telegraf/filters';
import { PrismaService } from 'src/prisma/prisma.service';
import { timeStamp } from 'console';


@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private bot: Telegraf<Context>;
  private logger = new Logger(BotService.name);
  private SYSTEM_PROMPT: string;

  constructor(private prisma: PrismaService) {
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
      await this.ensuerUser(ctx);
      await ctx.reply(
        'Привет! Отправь мне любое сообщение, и я обработаю его через ИИ.',
      );
    });

    // Обработка всех текстовых сообщений
    this.bot.on(message('text'), async (ctx) => {
      const user = await this.ensuerUser(ctx);
      const userMessage = ctx.message.text;

      await this.prisma.message.create({
        data: {
          content: userMessage,
          sender: 'user',
          userId: user.id,
        }
      })

      try {
        const aiResponse = await this.callOpenRouter(userMessage);
        this.logger.log("Ответ модели: ", aiResponse);
        await this.sendLongMessage(ctx, aiResponse.text, user.id);
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
    userId: bigint,
  ) {
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await ctx.reply(text);

      await this.prisma.message.create({
        data: {
          content: text, 
          sender: 'bot', 
          userId,
        }
      })
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

      await this.prisma.message.create({
        data: {
          content: chunk, 
          sender: 'bot', 
          userId,
        }
      })
      start = end;
    }
  }

private async callOpenRouter(userMessage: string): Promise<{ text: string; raw: string }> {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not defined in .env');
  }

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'nex-agi/deepseek-v3.1-nex-n1',
        messages: [
          { role: 'system', content: this.SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 1000,
        // 👇 Добавь это, если OpenRouter поддерживает (усиливает JSON-гарантию)
        // response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'http://localhost',
          'X-Title': 'My Telegram AI Bot',
          'Content-Type': 'application/json',
        },
      },
    );

    const aiText = response.data.choices[0]?.message?.content?.trim();
    if (!aiText) {
      throw new Error('Пустой ответ от OpenRouter');
    }

    // Попытка распарсить как JSON
    try {
      const parsed = JSON.parse(aiText);
      // Проверим, что есть хотя бы поле `text`
      if (typeof parsed.text === 'string') {
        return { text: parsed.text, raw: aiText };
      } else {
        // JSON есть, но нет `text` — вернём как есть
        return { text: aiText, raw: aiText };
      }
    } catch (parseError) {
      // Не JSON — вернём как обычный текст
      return { text: aiText, raw: aiText };
    }
  } catch (err) {
    this.logger.error(`Ошибка при запросе: ${err.message}`);
    throw new Error('Не удалось получить ответ от ИИ');
  }
}

  private async ensuerUser(ctx: Context): Promise<{id: bigint }> {
    const from = ctx.from;
    if (!from) throw new Error('No user info in context');

    const username = from.username || null;
    const firstName = from.first_name || null;
    const lastName = from.last_name || null;

    const user = await this.prisma.user.upsert({
      where: { id: BigInt(from.id) },
      update: {
        username,
        firstName,
        lastName,
      },
      create: {
        id: BigInt(from.id), // используем строку как ID
        username,
        firstName,
        lastName,
      },
    });

    return { id: user.id };
  }

}
