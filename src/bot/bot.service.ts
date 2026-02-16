import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Telegraf, Context, session } from 'telegraf';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { message } from 'telegraf/filters';
import { PrismaService } from 'src/prisma/prisma.service';
import { timeStamp } from 'console';
import cron from 'node-cron';
import { MyContext } from './interfaces';
import { LlmService } from 'src/llm/llm.service';
import { DatabaseService } from 'src/database/database.service';
import { errorMiddleware } from './bot.middleware';

// src/bot/bot.service.ts

type MyCtx = MyContext;

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private bot: Telegraf<MyCtx>;
  private logger = new Logger(BotService.name);

  constructor(
    private llm: LlmService,
    private db: DatabaseService,
  ) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not defined in .env');
    }
    this.bot = new Telegraf(token);
  }

  async onModuleInit() {
    this.bot.use(session());
    this.bot.use(errorMiddleware);

    this.registerCommands();
    this.registerHandlers();

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

  // ==================== КОМАНДЫ ====================

  private registerCommands() {
    this.bot.command('start', async (ctx) => {
      await this.ensureUser(ctx);
      await ctx.reply(
        'Привет! Отправь мне любое сообщение, и я обработаю его через ИИ.',
      );
    });

    this.bot.command('file', async (ctx) => {
      try {
        const userId = BigInt(ctx.from.id);
        const interactions = await this.db.getInteractions(userId);

        if (!interactions.length) {
          await ctx.reply('Нет записей');
          return;
        }

        const text = this.formatInteractions(interactions);
        const filename = `analysis_${Date.now()}.txt`;
        const filepath = path.join(process.cwd(), filename);

        fs.writeFileSync(filepath, text);

        await ctx.replyWithDocument({
          source: filepath,
          filename: filename,
        });

        fs.unlinkSync(filepath);
      } catch (e) {
        this.logger.error('Ошибка команды /file:', e);
        await ctx.reply('Ошибка: ' + (e as Error).message);
      }
    });

    this.bot.command('analyze', async (ctx) => {
      try {
        const userId = BigInt(ctx.from.id);
        await this.ensureUser(ctx);

        if (!ctx.session) ctx.session = {};

        await ctx.reply('Генерирую персональный отчёт...');

        const report = await this.db.generateBehaviorReport(userId, this.llm);
        await this.sendLongMessage(ctx, report, userId);

        ctx.session.postAnalysisMode = true;
        ctx.session.lastAnalysisReport = report;
      } catch (error) {
        this.logger.error('Ошибка генерации отчёта:', error);
        await ctx.reply('❌ Не удалось создать отчёт.');
      }
    });

    this.bot.command('core', async (ctx) => {
      await this.ensureUser(ctx);
      if (!ctx.session) ctx.session = {};

      ctx.session.postAnalysisMode = false;
      delete ctx.session.lastAnalysisReport;
      ctx.session.coreMode = true;

      await ctx.reply('🧠 Включён Core Mode. Спроси у себя вопрос.');
    });

    this.bot.command('done', async (ctx) => {
      if (!ctx.session) ctx.session = {};

      ctx.session.postAnalysisMode = false;
      ctx.session.coreMode = false;
      ctx.session.awaitingRuleContent = false;
      ctx.session.awaitingRuleDescription = false;
      delete ctx.session.lastAnalysisReport;
      delete ctx.session.ruleContent;

      await ctx.reply(
        '✅ Вернулись в обычный режим. Присылайте новую ситуацию.',
      );
    });

    this.bot.command('add_rule', async (ctx) => {
      await this.ensureUser(ctx);
      if (!ctx.session) ctx.session = {};

      ctx.session.coreMode = false;
      ctx.session.postAnalysisMode = false;
      delete ctx.session.lastAnalysisReport;

      ctx.session.awaitingRuleContent = true;
      ctx.session.awaitingRuleDescription = false;

      await ctx.reply(
        '✍️ Режим добавления правила.\n\n' +
          'Напишите само правило — краткую, чёткую формулировку того, как вы хотите действовать.\n' +
          'Пример: "Делать паузу 10 секунд перед ответом в конфликте"\n\n' +
          'Отмена: /done',
      );
    });

    this.bot.command('codex', async (ctx) => {
      try {
        const userId = BigInt(ctx.from.id);
        await this.ensureUser(ctx);

        const rules = await this.db.getUserRules(userId);

        if (rules.length === 0) {
          await ctx.reply(
            '📖 Ваш кодекс пуст. Добавьте первое правило через /add_rule',
          );
          return;
        }

        const codexText = rules
          .map(
            (rule, idx) =>
              `${idx + 1}. ${rule.content}${rule.description ? `\n   └─ ${rule.description}` : ''}`,
          )
          .join('\n\n');

        await ctx.reply(
          `📖 Ваш кодекс (${rules.length} правил):\n\n${codexText}`,
        );
      } catch (error) {
        this.logger.error('Ошибка команды /codex:', error);
        await ctx.reply('⚠️ Не удалось загрузить кодекс.');
      }
    });
  }

  // ==================== ОБРАБОТЧИКИ СООБЩЕНИЙ ====================

  private registerHandlers() {
    this.bot.on(message('text'), async (ctx) => {
      const msg = ctx.message;
      if (!msg || !('text' in msg)) return;

      const userText = msg.text;
      const userId = BigInt(ctx.from.id);

      await this.ensureUser(ctx);
      await this.db.saveMessage(userId, userText, 'user');

      // Приоритет: режимы сессии
      if (ctx.session?.awaitingRuleContent) {
        return this.handleRuleContent(ctx, userText);
      }

      if (ctx.session?.awaitingRuleDescription) {
        return this.handleRuleDescription(ctx, userText);
      }

      if (ctx.session?.coreMode) {
        return this.handleCoreModeMessage(ctx, userText);
      }

      if (ctx.session?.postAnalysisMode) {
        return this.handlePostAnalysisMessage(ctx, userText);
      }

      return this.handleRegularMessage(ctx, userText);
    });
  }

  // ==================== РЕЖИМЫ ====================

  private async handleRuleContent(ctx: MyCtx, content: string) {
    if (!ctx.session) ctx.session = {};

    ctx.session.ruleContent = content.trim();
    ctx.session.awaitingRuleContent = false;
    ctx.session.awaitingRuleDescription = true;

    await ctx.reply(
      '✅ Правило записано.\n' +
        'Хотите добавить пояснение? Напишите его или отправьте "-" для пропуска.',
    );
  }

  private async handleRuleDescription(ctx: MyCtx, input: string) {
    if (!ctx.from) {
      return;
    }

    const userId = BigInt(ctx.from.id);

    if (!ctx.session?.ruleContent) {
      await ctx.reply('❌ Сессия сбита. Начните заново через /add_rule');
      this.resetRuleSession(ctx);
      return;
    }

    try {
      const content = ctx.session.ruleContent;
      const description = input.trim() === '-' ? null : input.trim() || null;

      await this.db.createRule(userId, content, description);

      let confirmation = `✅ Правило добавлено в кодекс:\n«${content}»`;
      if (description) confirmation += `\n\nПояснение: ${description}`;

      await ctx.reply(confirmation);
    } catch (error) {
      this.logger.error('Ошибка сохранения правила:', error);
      await ctx.reply('❌ Не удалось сохранить правило.');
    }

    this.resetRuleSession(ctx);
  }

  private resetRuleSession(ctx: MyCtx) {
    if (!ctx.session) return;
    delete ctx.session.awaitingRuleContent;
    delete ctx.session.awaitingRuleDescription;
    delete ctx.session.ruleContent;
  }

  private async handlePostAnalysisMessage(ctx: MyCtx, userText: string) {
    if (!ctx.from) {
      return;
    }

    const userId = BigInt(ctx.from.id);
    const text = userText.trim();

    const exitWords = ['/done'];

    if (exitWords.some((word) => text.toLowerCase().includes(word))) {
      if (ctx.session) {
        ctx.session.postAnalysisMode = false;
        delete ctx.session.lastAnalysisReport;
      }
      await ctx.reply(
        'Режим анализа завершён. Можете прислать новую ситуацию.',
      );
      return;
    }

    try {
      const lastReport = ctx.session?.lastAnalysisReport || '';
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

      const aiText = await this.llm.callLLM(
        [{ role: 'user', content: qaPrompt }],
        300,
        0.7,
      );
      await this.sendLongMessage(ctx, aiText, userId);
    } catch (error) {
      this.logger.error('Ошибка в post-analysis режиме:', error);
      await ctx.reply('Не могу ответить сейчас. Но я здесь.');
    }
  }

  private async handleRegularMessage(ctx: MyCtx, userText: string) {
    if (!ctx.from) {
      return;
    }

    const userId = BigInt(ctx.from.id);
    const userMessageText = userText.trim();

    if (this.isStateCheckMessage(userMessageText)) {
      await ctx.reply('Спасибо, записал ✍️');
      return;
    }

    try {
      const systemPrompt = this.llm.getPrompt('DBT');

      const rawResponse = await this.llm.callLLM(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessageText },
        ],
        1200,
        0.9,
      );

      this.logger.log(
        'Ответ модели (raw):',
        rawResponse.substring(0, 200) + '...',
      );

      let parsed;
      try {
        parsed = JSON.parse(rawResponse);
      } catch (e) {
        this.logger.error(
          'Не удалось распарсить raw-ответ как JSON:',
          rawResponse,
        );
        throw new Error('Некорректный формат ответа от ИИ');
      }

      const aiText = this.generateReadableText(parsed);

      const lastUserMessage = await this.db.getLastUserMessage(userId);

      const result = await this.db.createInteraction(
        userId,
        {
          trigger: parsed.chain?.trigger ?? '',
          thought: parsed.chain?.thought ?? '',
          emotionName: parsed.chain?.emotion?.name ?? '',
          emotionIntensity: parsed.chain?.emotion?.intensity ?? 0,
          action: parsed.chain?.action ?? '',
          consequence: parsed.chain?.consequence ?? '',
          patterns: parsed.patterns ?? [],
          goal: parsed.analysis?.goal ?? '',
          ineffectivenessReason: parsed.analysis?.ineffectiveness_reason ?? '',
          hiddenNeed: parsed.analysis?.hidden_need ?? '',
          alternatives: parsed.alternatives ?? [],
          physiology: parsed.physiology ?? null,
          rawResponse,
        },
        lastUserMessage?.id,
      );

      // Обработка результата
      if (!result.created) {
        this.logger.debug(`Взаимодействие не создано: ${result.reason}`);

        // Опционально: сообщить пользователю, если это дубликат
        if (result.reason === 'duplicate_message') {
          // Можно отправить уведомление, но лучше молча пропустить
        }
      }

      await this.sendLongMessage(ctx, aiText, userId);

      // Асинхронная обработка статистики (не блокируем ответ)
      this.processStatsSafe(userId, userMessageText);
    } catch (error) {
      this.logger.error('Ошибка при обработке запроса:', error);
      await ctx.reply('⚠️ Произошла ошибка. Попробуйте позже.');
    }
  }

  private async handleCoreModeMessage(ctx: MyCtx, userText: string) {
    if (!ctx.from) {
      return;
    }

    const userId = BigInt(ctx.from.id);
    const text = userText.trim();

    if (['/done'].some((word) => text.toLowerCase().includes(word))) {
      if (ctx.session) {
        ctx.session.coreMode = false;
      }
      await ctx.reply('Режим Core завершён. Можете прислать новую ситуацию.');
      return;
    }

    try {
      const recentMessages = await this.db.getRecentUserMessages(userId, 3);
      const journalEntries = await this.db.getJournalEntriesText(userId, 8);
      const userRules = await this.db.getUserRulesForPrompt(userId);

      let corePromptTemplate = this.llm.getPrompt('CORE');
      if (!corePromptTemplate) {
        corePromptTemplate = 'Ты — глубокий психолог. Проанализируй следующее:';
      }

      const fullSystemPrompt = corePromptTemplate
        .replace('{{RECENT_MESSAGES}}', recentMessages)
        .replace('{{JOURNAL_ENTRIES}}', journalEntries)
        .replace('{{USER_RULES}}', userRules);

      const aiText = await this.llm.callLLM(
        [
          { role: 'system', content: fullSystemPrompt },
          { role: 'user', content: text },
        ],
        1000,
        0.95,
      );

      await this.sendLongMessage(ctx, aiText, userId);
    } catch (error) {
      this.logger.error('Ошибка в core-режиме:', error);
      await ctx.reply('Не могу ответить сейчас. Но я здесь.');
    }
  }

  // ==================== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ====================

  private async ensureUser(ctx: MyCtx) {
    if (!ctx.session) ctx.session = {};
    const user = ctx.from;

    if (!user) {
      return;
    }

    await this.db.ensureUser(user.id, {
      username: user.username || null,
      firstName: user.first_name || null,
      lastName: user.last_name || null,
    });
  }

  private async sendLongMessage(ctx: MyCtx, text: string, userId: bigint) {
    const MAX_LENGTH = 4096;

    if (text.length <= MAX_LENGTH) {
      await ctx.reply(text);
      await this.db.saveMessage(userId, text, 'bot');
      return;
    }

    let start = 0;
    while (start < text.length) {
      let end = start + MAX_LENGTH;

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
      await this.db.saveMessage(userId, chunk, 'bot');
      start = end;
    }
  }

  private isStateCheckMessage(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length > 70) return false;

    if (
      trimmed.includes('потому что') ||
      trimmed.includes('когда') ||
      trimmed.includes('после того')
    ) {
      return false;
    }

    const words = trimmed.split(/\s+/).length;
    return words <= 5;
  }

  private generateReadableText(parsed: any): string {
    const lines: string[] = [];

    lines.push(`1. ЦЕПЬ:`);
    lines.push(`Триггер — ${parsed.chain?.trigger || '-'}`);
    lines.push(`Мысль — "${parsed.chain?.thought || '-'}"`);
    lines.push(
      `Эмоция — ${parsed.chain?.emotion?.name || '-'} (${parsed.chain?.emotion?.intensity || 0}/10)`,
    );
    lines.push(`Действие — ${parsed.chain?.action || '-'}`);
    lines.push(`Последствие — ${parsed.chain?.consequence || '-'}`);

    lines.push(`2. ПАТТЕРНЫ: ${(parsed.patterns || []).join(', ') || '-'}`);

    lines.push(`3. АНАЛИЗ:`);
    lines.push(`Цель — ${parsed.analysis?.goal || '-'}`);
    lines.push(
      `Не сработало — ${parsed.analysis?.ineffectiveness_reason || '-'}`,
    );
    lines.push(`Скрытая потребность — ${parsed.analysis?.hidden_need || '-'}`);

    if (parsed.physiology) {
      lines.push(`4. ФИЗИОЛОГИЯ:`);
      lines.push(`Амигдала: ${parsed.physiology.amygdala_mechanism || '-'}`);
      lines.push(`Протокол: ${parsed.physiology.binary_protocol || '-'}`);
      lines.push(`Тело: ${parsed.physiology.physical_markers || '-'}`);
      lines.push(`ПФК: ${parsed.physiology.pfk_override_strategy || '-'}`);
    }

    lines.push(`5. АЛЬТЕРНАТИВЫ:`);
    if (parsed.alternatives?.length > 0) {
      parsed.alternatives.forEach((alt: string, index: number) => {
        lines.push(`${index + 1}) ${alt}`);
      });
    } else {
      lines.push(`-`);
    }

    return lines.join('\n');
  }

  private formatInteractions(interactions: any[]): string {
    if (interactions.length === 0) return '';

    return interactions
      .map((interaction) => {
        try {
          const rawData = JSON.parse(interaction.rawResponse);
          if (rawData.text) {
            return rawData.text;
          }
          return this.generateReadableText(rawData);
        } catch (error) {
          this.logger.error(`Ошибка парсинга для ${interaction.id}`, error);
          return `Ошибка отображения разбора от ${new Date(interaction.createdAt).toLocaleDateString()}`;
        }
      })
      .join('\n\n---\n\n');
  }

  private processStatsSafe(userId: bigint, messageText: string) {
    setImmediate(async () => {
      try {
        await this.db.processMessageForDailyStats(
          userId,
          messageText,
          this.llm,
        );
      } catch (error) {
        this.logger.warn('Ошибка обработки статистики:', error);
      }
    });
  }

  // ==================== МЕТОД ДЛЯ CRON (вызывается из SchedulerService) ====================

  async sendStateCheckToAllActiveUsers() {
    const activeUsers = await this.db.getActiveUsersForCron();

    for (const user of activeUsers) {
      try {
        const chatId = Number(user.id);
        await this.bot.telegram.sendMessage(
          chatId,
          '🧠 Как ты прямо сейчас?\n(Можно коротко: «устал», «радуюсь», «голоден», «раздражён» и т.д.)',
        );
      } catch (err) {
        this.logger.warn(
          `Не удалось отправить STATE_CHECK пользователю ${user.id}:`,
          (err as Error).message,
        );
      }
    }
  }
}
