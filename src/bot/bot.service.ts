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

    this.bot.command('analyze', async (ctx) => {
      const user = await this.ensuerUser(ctx);
      await ctx.reply(
        'Генерирую персональный отчёт по вашим последним взаимодействиям...',
      );

      try {
        const report = await this.generateBehaviorReport(user.id);
        await ctx.reply(report, { parse_mode: 'Markdown' }); // можно без Markdown
      } catch (error) {
        this.logger.error('Ошибка генерации отчёта:', error);
        await ctx.reply('❌ Не удалось создать отчёт. Попробуйте позже.');
      }
    });

    // Обработка всех текстовых сообщений
    this.bot.on(message('text'), async (ctx) => {
      const user = await this.ensuerUser(ctx);
      const userMessageText = ctx.message.text;

      const userMessage = await this.prisma.message.create({
        data: {
          content: userMessageText,
          sender: 'user',
          userId: user.id,
        },
      });

      try {
        // 2. Получаем ответ от ИИ
        const aiResponse = await this.callOpenRouter(userMessageText);
        this.logger.log('Ответ модели:', aiResponse);

        // 3. Парсим структурированный анализ
        let parsed;
        try {
          parsed = JSON.parse(aiResponse.raw);
        } catch (e) {
          this.logger.error(
            'Не удалось распарсить raw-ответ как JSON:',
            aiResponse.raw,
          );
          throw new Error('Некорректный формат ответа от ИИ');
        }

        // 4. Сохраняем Interaction
        await this.prisma.interaction.create({
          data: {
            userId: user.id,
            userMessageId: userMessage.id, // ← привязка к исходному сообщению
            trigger: parsed.chain.trigger,
            thought: parsed.chain.thought,
            emotionName: parsed.chain.emotion.name,
            emotionIntensity: parsed.chain.emotion.intensity,
            action: parsed.chain.action,
            consequence: parsed.chain.consequence,
            patterns: parsed.patterns, // Prisma автоматически сериализует в JSON
            goal: parsed.analysis.goal,
            ineffectivenessReason: parsed.analysis.ineffectiveness_reason,
            hiddenNeed: parsed.analysis.hidden_need,
            alternatives: parsed.alternatives,
            rawResponse: aiResponse.raw,
          },
        });

        // 5. Отправляем и сохраняем ответ бота
        await this.sendLongMessage(ctx, aiResponse.text, user.id);
      } catch (error) {
        this.logger.error('Ошибка при обработке запроса:', error);
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

  private async sendLongMessage(ctx: Context, text: string, userId: bigint) {
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await ctx.reply(text);

      await this.prisma.message.create({
        data: {
          content: text,
          sender: 'bot',
          userId,
        },
      });
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
        },
      });
      start = end;
    }
  }

  private async callOpenRouter(
    userMessage: string,
  ): Promise<{ text: string; raw: string }> {
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

  private async ensuerUser(ctx: Context): Promise<{ id: bigint }> {
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

  private async generateBehaviorReport(userId: bigint): Promise<string> {
    const interactions = await this.prisma.interaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    if (interactions.length === 0) {
      return 'У вас пока нет сохранённых разборов. Напишите боту ситуацию, чтобы начать анализ.';
    }

    const historyText = interactions
      .map((i) => {
        const patterns = Array.isArray(i.patterns)
          ? i.patterns
          : JSON.parse(i.patterns as any);
        return `[${i.createdAt.toLocaleDateString()}] Триггер: "${i.trigger}". Эмоция: ${i.emotionName} (${i.emotionIntensity}/10). Паттерны: ${patterns.join(', ')}. Последствие: "${i.consequence}"`;
      })
      .join('\n');

    const prompt = fs
      .readFileSync(
        path.join(
          process.cwd(),
          'src',
          'llm',
          'prompts',
          'BehaviorAnalysisPrompt.txt',
        ),
        'utf-8',
      )
      .replace('{{HISTORY}}', historyText);

    this.logger.log('PROMT', prompt);

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'nex-agi/deepseek-v3.1-nex-n1', // ← лучше использовать gpt-4o-mini или claude — они точнее в анализе
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
      },
    );

    return (
      response.data.choices[0]?.message?.content?.trim() ||
      'Не удалось сгенерировать отчёт.'
    );
  }
}
