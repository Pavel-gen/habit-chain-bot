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

interface MySession {
  postAnalysisMode?: boolean;
  lastAnalysisReport?: string;
  coreMode?: boolean;
  awaitingRuleContent?: boolean;
  awaitingRuleDescription?: boolean;
  ruleContent?: string;
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
    this.startStateCheckCron();

    this.SYSTEM_PROMPT = fs.readFileSync(promptPath, 'utf-8').trim();

    // Команда /start
    this.bot.command('start', async (ctx) => {
      await this.ensureUser(ctx);
      await ctx.reply(
        'Привет! Отправь мне любое сообщение, и я обработаю его через ИИ.',
      );
    });

    this.bot.command('analyze', async (ctx: MyContext) => {
      const user = await this.ensureUser(ctx);

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
      const user = await this.ensureUser(ctx);

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

    this.bot.command('add_rule', async (ctx: MyContext) => {
      const user = await this.ensureUser(ctx);

      if (!ctx.session) ctx.session = {};

      // Сбрасываем другие режимы
      ctx.session.coreMode = false;
      ctx.session.postAnalysisMode = false;
      delete ctx.session.lastAnalysisReport;

      // Включаем режим добавления правила
      ctx.session.awaitingRuleContent = true;
      ctx.session.awaitingRuleDescription = false;

      await ctx.reply(
        '✍️ Режим добавления правила.\n\n' +
          'Напишите само правило — краткую, чёткую формулировку того, как вы хотите действовать.\n' +
          'Пример: "Делать паузу 10 секунд перед ответом в конфликте"\n\n' +
          'Отмена: /done',
      );
    });

    this.bot.command('codex', async (ctx: MyContext) => {
      const user = await this.ensureUser(ctx);

      const rules = await this.prisma.rule.findMany({
        where: { userId: user.id, isActive: true },
        orderBy: { createdAt: 'asc' },
      });

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
    });

    // === Основной обработчик текста ===
    this.bot.on(message('text'), async (ctx: MyContext) => {
      const msg = ctx.message;
      if (!msg || !('text' in msg)) return;

      const userText = msg.text;

      if (ctx.session?.awaitingRuleContent) {
        return this.handleRuleContent(ctx, userText);
      }

      if (ctx.session?.awaitingRuleDescription) {
        return this.handleRuleDescription(ctx, userText);
      }

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

  private startStateCheckCron() {
    // Запуск каждые 4 часа
    cron.schedule('0 9-23/3 * * *', async () => {
      try {
        await this.sendStateCheckToAllActiveUsers();
      } catch (error) {
        this.logger.error(
          'Ошибка в крон-задаче sendStateCheckToAllActiveUsers:',
          error,
        );
      }
    });
    this.logger.log('Запланирована крон-задача: опрос состояния каждые 4 часа');
  }

  private async handleRuleContent(ctx: MyContext, content: string) {
    const user = await this.ensureUser(ctx);

    if (!ctx.session) ctx.session = {};

    // Сохраняем контент правила в сессии
    ctx.session.ruleContent = content.trim();
    ctx.session.awaitingRuleContent = false;
    ctx.session.awaitingRuleDescription = true;

    await ctx.reply(
      '✅ Правило записано.\n' +
        'Хотите добавить пояснение? Напишите его или отправьте "-" для пропуска.',
    );
  }

  private async handleRuleDescription(ctx: MyContext, input: string) {
    const user = await this.ensureUser(ctx);

    if (!ctx.session?.ruleContent) {
      await ctx.reply('❌ Сессия сбита. Начните заново через /add_rule');
      this.resetRuleSession(ctx);
      return;
    }

    const content = ctx.session.ruleContent;
    const description = input.trim() === '-' ? null : input.trim() || null;

    // Сохраняем правило
    await this.prisma.rule.create({
      data: {
        userId: user.id,
        content,
        description,
      },
    });

    // Подтверждение
    let confirmation = `✅ Правило добавлено в кодекс:\n«${content}»`;
    if (description) confirmation += `\n\nПояснение: ${description}`;

    await ctx.reply(confirmation);

    // Сбрасываем сессию
    this.resetRuleSession(ctx);
  }

  private resetRuleSession(ctx: MyContext) {
    if (!ctx.session) return;
    delete ctx.session.awaitingRuleContent;
    delete ctx.session.awaitingRuleDescription;
    delete ctx.session.ruleContent;
  }

  private async sendStateCheckToAllActiveUsers() {
    const activeUsers = await this.prisma.user.findMany({
      where: {
        messages: {
          some: {
            createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        },
      },
      select: { id: true }, // ← только id, который и есть telegramId
    });

    for (const user of activeUsers) {
      try {
        // user.id — это BigInt, но Telegram Bot API принимает number или string
        // В JS/TS number безопасен до 2^53, а Telegram ID < 2^53, так что можно привести к number
        const chatId = Number(user.id);

        await this.bot.telegram.sendMessage(
          chatId,
          '🧠 Как ты прямо сейчас?\n(Можно коротко: «устал», «радуюсь», «голоден», «раздражён» и т.д.)',
        );
      } catch (err) {
        this.logger.warn(
          `Не удалось отправить STATE_CHECK пользователю ${user.id}:`,
          err.message,
        );
      }
    }
  }

  async onModuleDestroy() {
    await this.bot.stop('SIGTERM');
  }

  private async sendLongMessage(ctx: MyContext, text: string, userId: bigint) {
    const MAX_LENGTH = 4096;

    if (text.length <= MAX_LENGTH) {
      await ctx.reply(text);
      await this.saveMessage(userId, text, 'bot'); // ← универсальная функция
      return;
    }

    // Разбиваем на части, стараясь не резать слова
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
      await this.saveMessage(userId, chunk, 'bot'); // ← универсальная функция
      start = end;
    }
  }

  private async handlePostAnalysisMessage(ctx: MyContext, userText: string) {
    const user = await this.ensureUser(ctx);
    const text = userText.trim();

    await this.saveMessage(user.id, text, 'user');

    const exitWords = [
      'стоп',
      'хватит',
      'всё',
      'спасибо',
      'готово',
      'конец',
      '/done',
    ];
    if (exitWords.some((word) => text.toLowerCase().includes(word))) {
      ctx.session.postAnalysisMode = false;
      delete ctx.session.lastAnalysisReport;
      await ctx.reply(
        'Режим анализа завершён. Можете прислать новую ситуацию.',
      );
      return;
    }

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
      const aiText = await this.callLLM(
        [{ role: 'user', content: qaPrompt }],
        300,
        0.7,
      );
      await this.sendLongMessage(ctx, aiText, user.id);
    } catch (error) {
      this.logger.error('Ошибка в post-analysis режиме:', error.message);
      await ctx.reply('Не могу ответить сейчас. Но я здесь.');
    }
  }

  // === Обычный режим: разбор новой ситуации ===
  private async handleRegularMessage(ctx: MyContext, userText: string) {
    const user = await this.ensureUser(ctx);
    const userMessageText = userText.trim();

    // Сохраняем сообщение пользователя
    await this.saveMessage(user.id, userMessageText, 'user');

    // 🔹 Проверка: если это похоже на STATE_CHECK — не анализируем
    if (this.isStateCheckMessage(userMessageText)) {
      await ctx.reply('Спасибо, записал ✍️');
      return;
    }

    try {
      // Загружаем основной промпт
      const mainPromptPath = path.join(
        process.cwd(),
        'src',
        'llm',
        'prompts',
        'DBTpromt1.txt',
      );
      const SYSTEM_PROMPT = fs.readFileSync(mainPromptPath, 'utf-8').trim();

      // Получаем raw-ответ от модели (ожидается JSON-строка)
      const rawResponse = await this.callLLM(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessageText },
        ],
        1200,
        0.9,
      );

      this.logger.log('Ответ модели (raw):', rawResponse);

      // Парсим JSON
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

      // Извлекаем текст для отправки пользователю (например, из поля `text` или `response`)
      // ← Уточните, откуда берётся `aiResponse.text` в вашем текущем коде.
      // Предположим, что модель возвращает объект с полем `text`.
      const aiText = this.generateReadableText(parsed);

      // Сохраняем структурированный анализ
      await this.prisma.interaction.create({
        data: {
          userId: user.id,
          // Связываем с последним сообщением пользователя (можно уточнить логику)
          userMessageId: (
            await this.prisma.message.findFirst({
              where: { userId: user.id, sender: 'user' },
              orderBy: { createdAt: 'desc' },
            })
          )?.id,
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
          physiology: parsed.phusiology ?? null,
          rawResponse,
        },
      });

      // Отправляем и сохраняем ответ бота
      await this.sendLongMessage(ctx, aiText, user.id);
    } catch (error) {
      this.logger.error('Ошибка при обработке запроса:', error);
      await ctx.reply('⚠️ Произошла ошибка. Попробуйте позже.');
    }
  }

  // Функция для преобразования JSON-анализа в читаемый текст
  private generateReadableText(parsed: any): string {
    const lines: string[] = [];

    // 1. Цепь событий
    lines.push(`1. ЦЕПЬ:`);
    lines.push(`   Триггер — ${parsed.chain?.trigger || '-'}`);
    lines.push(`   Мысль — "${parsed.chain?.thought || '-'}"`);
    lines.push(
      `   Эмоция — ${parsed.chain?.emotion?.name || '-'} (${parsed.chain?.emotion?.intensity || 0}/10)`,
    );
    lines.push(`   Действие — ${parsed.chain?.action || '-'}`);
    lines.push(`   Последствие — ${parsed.chain?.consequence || '-'}`);

    // 2. Паттерны
    lines.push(`2. ПАТТЕРНЫ: ${(parsed.patterns || []).join(', ') || '-'}`);

    // 3. Анализ
    lines.push(`3. АНАЛИЗ:`);
    lines.push(`   Цель — ${parsed.analysis?.goal || '-'}`);
    lines.push(
      `   Не сработало — ${parsed.analysis?.ineffectiveness_reason || '-'}`,
    );
    lines.push(
      `   Скрытая потребность — ${parsed.analysis?.hidden_need || '-'}`,
    );

    // 4. Физиология
    if (parsed.physiology) {
      lines.push(`4. ФИЗИОЛОГИЯ:`);
      lines.push(`   Амигдала: ${parsed.physiology.amygdala_mechanism || '-'}`);
      lines.push(`   Протокол: ${parsed.physiology.binary_protocol || '-'}`);
      lines.push(`   Тело: ${parsed.physiology.physical_markers || '-'}`);
      lines.push(`   ПФК: ${parsed.physiology.pfk_override_strategy || '-'}`);
    }

    // 5. Альтернативы
    lines.push(`5. АЛЬТЕРНАТИВЫ:`);
    if (parsed.alternatives?.length > 0) {
      parsed.alternatives.forEach((alt: string, index: number) => {
        lines.push(`   ${index + 1}) ${alt}`);
      });
    } else {
      lines.push(`   -`);
    }

    return lines.join('\n');
  }

  private isStateCheckMessage(text: string): boolean {
    const trimmed = text.trim();
    // Слишком длинное — не STATE_CHECK
    if (trimmed.length > 70) return false;

    // Содержит сложные конструкции? (признак анализа ситуации)
    if (
      trimmed.includes('потому что') ||
      trimmed.includes('когда') ||
      trimmed.includes('после того')
    ) {
      return false;
    }

    // Слишком короткое или простое — вероятно, состояние
    const words = trimmed.split(/\s+/).length;
    return words <= 5; // максимум 5 слов
  }

  private async ensureUser(ctx: MyContext): Promise<{ id: bigint }> {
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
      take: 5,
    });

    if (interactions.length === 0) {
      return 'У вас пока нет сохранённых разборов. Напишите боту ситуацию, чтобы начать анализ.';
    }

    const historyText = this.formatInteractions(interactions);
    const messagesText = await this.getRecentUserMessages(userId, 3);
    const journalText = await this.getJournalEntriesText(userId, 8);
    const userRules = await this.getUserRulesForPrompt(userId);

    const promptTemplate = fs.readFileSync(
      path.join(
        process.cwd(),
        'src',
        'llm',
        'prompts',
        'BehaviorAnalysisPrompt.txt',
      ),
      'utf-8',
    );

    const prompt = promptTemplate
      .replace('{{RECENT_MESSAGES}}', messagesText)
      .replace('{{JOURNAL_ENTRIES}}', journalText)
      .replace('{{HISTORY}}', historyText)
      .replace('{{USER_RULES}}', userRules);

    return await this.callLLM([{ role: 'user', content: prompt }], 1000, 0.9);
  }

  private async handleCoreModeMessage(ctx: MyContext, userText: string) {
    const user = await this.ensureUser(ctx);
    const text = userText.trim();

    await this.saveMessage(user.id, text, 'user');

    if (['/done'].some((word) => text.toLowerCase().includes(word))) {
      ctx.session.coreMode = false;
      await ctx.reply('Режим Core завершён. Можете прислать новую ситуацию.');
      return;
    }

    // Получаем контекст
    const recentMessages = await this.getRecentUserMessages(user.id, 3);
    const journalEntries = await this.getJournalEntriesText(user.id, 8); // чуть меньше, чтобы не перегружать
    const userRules = await this.getUserRulesForPrompt(user.id);

    let CORE_PROMPT_TEMPLATE: string;
    try {
      const corePromptPath = path.join(
        process.cwd(),
        'src',
        'llm',
        'prompts',
        'core_prompt.txt',
      );
      CORE_PROMPT_TEMPLATE = fs.readFileSync(corePromptPath, 'utf-8').trim();
    } catch (err) {
      this.logger.error('Не удалось загрузить core_prompt.txt:', err);
      CORE_PROMPT_TEMPLATE = 'Ты — глубокий психолог. Проанализируй следующее:';
    }

    // Подставляем контекст в шаблон
    const fullSystemPrompt = CORE_PROMPT_TEMPLATE.replace(
      '{{RECENT_MESSAGES}}',
      recentMessages,
    )
      .replace('{{JOURNAL_ENTRIES}}', journalEntries)
      .replace('{{USER_RULES}}', userRules);

    try {
      const aiText = await this.callLLM(
        [
          { role: 'system', content: fullSystemPrompt },
          { role: 'user', content: text },
        ],
        1000,
        0.95,
      );

      await this.sendLongMessage(ctx, aiText, user.id);
    } catch (error) {
      this.logger.error('Ошибка в core-режиме:', error.message);
      await ctx.reply('Не могу ответить сейчас. Но я здесь.');
    }
  }

  private async saveMessage(
    userId: bigint,
    content: string,
    sender: 'user' | 'bot',
  ): Promise<void> {
    const message = await this.prisma.message.create({
      data: {
        content,
        sender, // ← enum значения должны совпадать с Prisma-схемой (у вас 'user'/'bot')
        userId,
      },
    });

    if (sender === 'user') {
      // Запускаем асинхронно, чтобы не блокировать ответ пользователю
      setImmediate(() => {
        this.createJournalEntryFromMessage(userId, message.id, content).catch(
          () => {
            /* ошибки уже залогированы внутри */
          },
        );
      });
    }
  }

  private async callLLM(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    maxTokens: number = 1000,
    temperature: number = 0.95,
  ): Promise<string> {
    this.logger.log('messages', messages);

    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'deepseek/deepseek-v3.2',
          messages,
          max_tokens: maxTokens,
          temperature,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
        },
      );

      return response.data.choices[0]?.message?.content?.trim() || '...';
    } catch (error) {
      this.logger.error('Ошибка вызова LLM:', error.message || error);
      throw new Error('Не удалось получить ответ от модели.');
    }
  }

  private async createJournalEntryFromMessage(
    userId: bigint,
    messageId: string,
    messageText: string,
  ): Promise<void> {
    const trimmed = messageText.trim();

    // 1. Игнорируем пустые сообщения
    if (!trimmed) {
      return;
    }

    // 2. Игнорируем команды Telegram
    if (/^\/[a-z0-9_]+/i.test(trimmed)) {
      return;
    }

    try {
      const promptTemplate = fs.readFileSync(
        path.join(
          process.cwd(),
          'src',
          'llm',
          'prompts',
          'message_to_journal.txt',
        ),
        'utf-8',
      );
      const prompt = promptTemplate.replace('{{MESSAGE}}', trimmed);

      const rawResponse = await this.callLLM(
        [{ role: 'user', content: prompt }],
        400,
        0.3,
      );

      let parsed;
      try {
        parsed = JSON.parse(rawResponse);
      } catch (e) {
        this.logger.warn('Не удалось распарсить journal entry:', rawResponse);
        return;
      }

      // 3. Если LLM вернул пустой/бессмысленный ответ — не сохраняем
      if (!parsed?.content?.trim()) {
        return;
      }

      await this.prisma.journalEntry.create({
        data: {
          userId,
          sourceMessageId: messageId,
          type: parsed.type || 'INSIGHT', // fallback
          content: parsed.content.trim(),
          description: parsed.description?.trim() || null,
        },
      });

      this.logger.debug(
        `Создана запись журнала для userId=${userId}: ${parsed.content}`,
      );
    } catch (error) {
      this.logger.error('Ошибка при создании JournalEntry:', error.message);
    }
  }

  private async getUserRulesForPrompt(userId: bigint): Promise<string> {
    const rules = await this.prisma.rule.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { content: true, description: true },
    });

    if (rules.length === 0) return 'NO_RULES';

    return rules
      .map((rule, idx) => {
        const parts = [`RULE_${idx + 1}: "${rule.content}"`];
        if (rule.description) {
          parts.push(`  CONTEXT: "${rule.description}"`);
        }
        return parts.join('\n');
      })
      .join('\n\n');
  }

  private async getRecentUserMessages(
    userId: bigint,
    limit = 5,
  ): Promise<string> {
    const messages = await this.prisma.message.findMany({
      where: { userId, sender: 'user' },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { content: true, createdAt: true },
    });

    if (messages.length === 0) return '— нет недавних сообщений';

    return messages
      .reverse()
      .map((m) => `[${m.createdAt.toLocaleString()}] ${m.content}`)
      .join('\n');
  }

  private async getJournalEntriesText(
    userId: bigint,
    limit = 20,
  ): Promise<string> {
    const entries = await this.prisma.journalEntry.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { type: true, content: true, description: true, createdAt: true },
    });

    if (entries.length === 0) return '— нет записей';

    return entries
      .map(
        (j) =>
          `[${j.createdAt.toLocaleDateString()}] [${j.type}] ${j.content}` +
          (j.description ? `\n  → ${j.description}` : ''),
      )
      .join('\n');
  }

  private formatInteractions(interactions: any[]): string {
    if (interactions.length === 0) return '';

    return interactions
      .map((interaction) => {
        try {
          // Парсим rawResponse
          const rawData = JSON.parse(interaction.rawResponse);
          // Если в rawData уже есть text, используем его
          if (rawData.text) {
            return rawData.text;
          }
          // Иначе генерируем из структуры
          return this.generateReadableText(rawData);
        } catch (error) {
          this.logger.error(`Ошибка парсинга для ${interaction.id}`, error);
          return `Ошибка отображения разбора от ${new Date(interaction.createdAt).toLocaleDateString()}`;
        }
      })
      .join('\n\n---\n\n');
  }
}
