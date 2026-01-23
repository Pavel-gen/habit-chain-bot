import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Telegraf, Context, session } from 'telegraf';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { message } from 'telegraf/filters';
import { PrismaService } from 'src/prisma/prisma.service';
import { timeStamp } from 'console';

interface MySession {
  postAnalysisMode?: boolean;
  lastAnalysisReport?: string;
  coreMode?: boolean;
}

type MyContext = Context & { session: MySession };

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private bot: Telegraf<MyContext>;
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

    this.bot.command('analyze', async (ctx: MyContext) => {
      const user = await this.ensuerUser(ctx);

      if (!ctx.session) {
        ctx.session = {};
      }

      await ctx.reply('Генерирую персональный отчёт...');

      try {
        const report = await this.generateBehaviorReport(user.id);
        await this.sendLongMessage(ctx, report, user.id);

        ctx.session.postAnalysisMode = true;
        ctx.session.lastAnalysisReport = report;
      } catch (error) {
        this.logger.error('Ошибка генерации отчёта:', error.message);
        await ctx.reply('❌ Не удалось создать отчёт.');
      }
    });

    this.bot.command('core', async (ctx: MyContext) => {
      const user = await this.ensuerUser(ctx);

      if (!ctx.session) {
        ctx.session = {};
      }

      // Выключаем другие режимы
      ctx.session.postAnalysisMode = false;
      delete ctx.session.lastAnalysisReport;

      // Включаем core-режим
      ctx.session.coreMode = true;

      await ctx.reply('🧠 Включён Core Mode. Спроси у себя вопрос.');
    });

    this.bot.command('done', async (ctx: MyContext) => {
      if (!ctx.session) {
        ctx.session = {};
      }

      // Сбрасываем все специальные режимы
      ctx.session.postAnalysisMode = false;
      ctx.session.coreMode = false;
      delete ctx.session.lastAnalysisReport;

      await ctx.reply(
        '✅ Вернулись в обычный режим. Присылайте новую ситуацию.',
      );
    });
    // === Основной обработчик текста ===
    this.bot.on(message('text'), async (ctx: MyContext) => {
      const msg = ctx.message;
      if (!msg || !('text' in msg)) return;

      const userText = msg.text;

      // Приоритет: сначала специальные режимы
      if (ctx.session?.coreMode) {
        return this.handleCoreModeMessage(ctx, userText);
      }

      if (ctx.session?.postAnalysisMode) {
        return this.handlePostAnalysisMessage(ctx, userText);
      }

      return this.handleRegularMessage(ctx, userText);
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

  private async sendLongMessage(ctx: MyContext, text: string, userId: bigint) {
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

  private async handlePostAnalysisMessage(ctx: MyContext, userText: string) {
    const user = await this.ensuerUser(ctx);
    const text = userText.trim();

    // Сохраняем сообщение
    await this.prisma.message.create({
      data: { content: text, sender: 'user', userId: user.id },
    });

    // Проверка на выход
    const exitWords = ['стоп', 'хватит', 'всё', 'спасибо', 'готово', 'конец'];
    if (exitWords.some((word) => text.toLowerCase().includes(word))) {
      ctx.session.postAnalysisMode = false;
      delete ctx.session.lastAnalysisReport;
      await ctx.reply(
        'Режим анализа завершён. Можете прислать новую ситуацию.',
      );
      return;
    }

    // Генерация ответа с контекстом отчёта
    const lastReport = ctx.session.lastAnalysisReport || '';
    const qaPrompt = `
Ты — терапевт. Пользователь получил следующий анализ:

---
${lastReport}
---

Он пишет:
«${text}»

Дай **чёткий, содержательный ответ**, основанный на этом анализе.
- Не повторяй отчёт.
- Ответь по существу.
- Если вопрос эмоциональный — свяжи с паттерном.
- Максимум 3–4 предложения. Прямо. Без жаргона.
`.trim();

    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'deepseek/deepseek-v3.2',
          messages: [{ role: 'user', content: qaPrompt }],
          max_tokens: 300,
          temperature: 0.7,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const aiText =
        response.data.choices[0]?.message?.content?.trim() || '...';

      await this.sendLongMessage(ctx, aiText, user.id);

      // Сохраняем ответ бота
      await this.prisma.message.create({
        data: { content: aiText, sender: 'bot', userId: user.id },
      });
    } catch (error) {
      this.logger.error('Ошибка в post-analysis режиме:', error.message);
      await ctx.reply('Не могу ответить сейчас. Но я здесь.');
    }
  }

  // === Обычный режим: разбор новой ситуации ===
  private async handleRegularMessage(ctx: MyContext, userText: string) {
    const user = await this.ensuerUser(ctx);
    const userMessageText = userText.trim();

    const userMessage = await this.prisma.message.create({
      data: {
        content: userMessageText,
        sender: 'user',
        userId: user.id,
      },
    });

    try {
      const aiResponse = await this.callOpenRouter(userMessageText);
      this.logger.log('Ответ модели:', aiResponse.raw);

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

      await this.prisma.interaction.create({
        data: {
          userId: user.id,
          userMessageId: userMessage.id,
          trigger: parsed.chain.trigger,
          thought: parsed.chain.thought,
          emotionName: parsed.chain.emotion.name,
          emotionIntensity: parsed.chain.emotion.intensity,
          action: parsed.chain.action,
          consequence: parsed.chain.consequence,
          patterns: parsed.patterns,
          goal: parsed.analysis.goal,
          ineffectivenessReason: parsed.analysis.ineffectiveness_reason,
          hiddenNeed: parsed.analysis.hidden_need,
          alternatives: parsed.alternatives,
          rawResponse: aiResponse.raw,
        },
      });

      await this.sendLongMessage(ctx, aiResponse.text, user.id);
    } catch (error) {
      this.logger.error('Ошибка при обработке запроса:', error);
      await ctx.reply('⚠️ Произошла ошибка. Попробуйте позже.');
    }
  }

  private async ensuerUser(ctx: MyContext): Promise<{ id: bigint }> {
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
        const alternatives = Array.isArray(i.alternatives)
          ? i.alternatives
          : JSON.parse(i.alternatives as any);

        return `[${i.createdAt.toLocaleDateString()}]
            Цель: "${i.goal || 'не указана'}"
            Триггер: "${i.trigger}"
            Мысль: "${i.thought}"
            Эмоция: ${i.emotionName} (${i.emotionIntensity}/10)
            Действие: "${i.action}"
            Последствие: "${i.consequence}"
            Скрытая потребность: "${i.hiddenNeed || 'не распознана'}"
            Паттерны: ${patterns.length > 0 ? patterns.join(', ') : '—'}
            Альтернативы: ${alternatives.length > 0 ? alternatives.join('; ') : '—'}`;
      })
      .join('\n\n');

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
        model: 'deepseek/deepseek-v3.2', // ← лучше использовать gpt-4o-mini или claude — они точнее в анализе
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
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

  private async handleCoreModeMessage(ctx: MyContext, userText: string) {
    const user = await this.ensuerUser(ctx);
    const text = userText.trim();

    // Сохраняем сообщение пользователя
    await this.prisma.message.create({
      data: { content: text, sender: 'user', userId: user.id },
    });

    // Проверка на выход (опционально, но удобно)
    const exitWords = ['/done'];
    if (exitWords.some((word) => text.toLowerCase().includes(word))) {
      ctx.session.coreMode = false;
      await ctx.reply('Режим Core завершён. Можете прислать новую ситуацию.');
      return;
    }

    // Загружаем промпт для core-режима
    let CORE_PROMPT: string;
    try {
      const corePromptPath = path.join(
        process.cwd(),
        'src',
        'llm',
        'prompts',
        'core_prompt.txt',
      );
      CORE_PROMPT = fs.readFileSync(corePromptPath, 'utf-8').trim();
    } catch (err) {
      this.logger.error('Не удалось загрузить core_prompt.txt:', err);
      CORE_PROMPT = 'Ты — глубокий психолог. Проанализируй следующее:';
    }

    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'deepseek/deepseek-v3.2',
          messages: [
            { role: 'system', content: CORE_PROMPT },
            { role: 'user', content: text },
          ],
          max_tokens: 1000,
          temperature: 0.95,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const aiText =
        response.data.choices[0]?.message?.content?.trim() || '...';

      await this.sendLongMessage(ctx, aiText, user.id);

      // Сохраняем ответ бота
      await this.prisma.message.create({
        data: { content: aiText, sender: 'bot', userId: user.id },
      });
    } catch (error) {
      this.logger.error('Ошибка в core-режиме:', error.message);
      await ctx.reply('Не могу ответить сейчас. Но я здесь.');
    }
  }
}
