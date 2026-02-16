// src/database/database.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { LlmService } from 'src/llm/llm.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class DatabaseService {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(private prisma: PrismaService) {}

  // ==================== USER ====================

  async ensureUser(
    telegramId: number,
    userData: {
      username: string | null;
      firstName: string | null;
      lastName: string | null;
    },
  ) {
    return this.prisma.user.upsert({
      where: { id: BigInt(telegramId) },
      update: {
        username: userData.username,
        firstName: userData.firstName,
        lastName: userData.lastName,
      },
      create: {
        id: BigInt(telegramId),
        username: userData.username,
        firstName: userData.firstName,
        lastName: userData.lastName,
      },
    });
  }

  // ==================== MESSAGE ====================

  async saveMessage(userId: bigint, content: string, sender: 'user' | 'bot') {
    return this.prisma.message.create({
      data: {
        content,
        sender,
        userId,
      },
    });
  }

  async getLastUserMessage(userId: bigint) {
    return this.prisma.message.findFirst({
      where: { userId, sender: 'user' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getRecentUserMessages(userId: bigint, limit = 5): Promise<string> {
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

  // ==================== INTERACTION ====================

  async getInteractions(userId: bigint) {
    return this.prisma.interaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createInteraction(
    userId: bigint,
    data: {
      trigger: string;
      thought: string;
      emotionName: string;
      emotionIntensity: number;
      action: string;
      consequence: string;
      patterns: string[];
      goal: string;
      ineffectivenessReason: string;
      hiddenNeed: string;
      alternatives: string[];
      physiology: any;
      rawResponse: string;
    },
    userMessageId?: string,
  ): Promise<{ created: boolean; interaction?: any; reason?: string }> {
    // === 🔹 ПРОВЕРКА 1: Уже есть взаимодействие для этого сообщения? ===
    if (userMessageId) {
      const existingInteraction =
        await this.hasInteractionForMessage(userMessageId);
      if (existingInteraction) {
        this.logger.debug(
          `Взаимодействие уже существует для сообщения ${userMessageId}`,
        );
        return {
          created: false,
          interaction: existingInteraction,
          reason: 'interaction_exists',
        };
      }
    }

    // === 🔹 ПРОВЕРКА 2: Дубликат сообщения за последний час? ===
    // Получаем текст сообщения для проверки на дубликат
    if (userMessageId) {
      const message = await this.prisma.message.findUnique({
        where: { id: userMessageId },
        select: { content: true, createdAt: true },
      });

      if (message) {
        const isDuplicate = await this.isDuplicateInteractionMessage(
          userId,
          message.content,
          message.createdAt,
        );

        if (isDuplicate) {
          this.logger.debug(
            `Дубликат сообщения для взаимодействия: ${message.content.substring(0, 50)}...`,
          );
          return {
            created: false,
            reason: 'duplicate_message',
          };
        }
      }
    }

    // === 🔹 СОЗДАНИЕ ВЗАИМОДЕЙСТВИЯ ===
    try {
      const interaction = await this.prisma.interaction.create({
        data: {
          userId,
          userMessageId,
          trigger: data.trigger,
          thought: data.thought,
          emotionName: data.emotionName,
          emotionIntensity: data.emotionIntensity,
          action: data.action,
          consequence: data.consequence,
          patterns: data.patterns,
          goal: data.goal,
          ineffectivenessReason: data.ineffectivenessReason,
          hiddenNeed: data.hiddenNeed,
          alternatives: data.alternatives,
          physiology: data.physiology,
          rawResponse: data.rawResponse,
        },
      });

      this.logger.debug(
        `Создано взаимодействие для userId=${userId}, messageId=${userMessageId}`,
      );
      return {
        created: true,
        interaction,
      };
    } catch (error) {
      this.logger.error('Ошибка при создании взаимодействия:', error);
      throw error;
    }
  }

  // === 🔹 ПРОВЕРКА: Есть ли уже взаимодействие для этого сообщения? ===
  async hasInteractionForMessage(userMessageId: string): Promise<any> {
    return this.prisma.interaction.findFirst({
      where: {
        userMessageId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // === 🔹 ПРОВЕРКА: Дубликат сообщения для взаимодействия ===
  async isDuplicateInteractionMessage(
    userId: bigint,
    messageText: string,
    messageCreatedAt: Date,
  ): Promise<boolean> {
    const oneHourAgo = new Date(messageCreatedAt.getTime() - 60 * 60 * 1000);

    // Ищем сообщения пользователя за последний час
    const recentMessages = await this.prisma.message.findMany({
      where: {
        userId,
        sender: 'user',
        createdAt: {
          gte: oneHourAgo,
          lte: messageCreatedAt,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { content: true, createdAt: true, id: true },
    });

    // Исключаем текущее сообщение из проверки
    const otherMessages = recentMessages.filter(
      (msg) => msg.id !== messageCreatedAt.toISOString(),
    );

    // Нормализуем текст для сравнения
    const normalizedNew = this.normalizeMessageText(messageText);

    for (const msg of otherMessages) {
      const normalizedExisting = this.normalizeMessageText(msg.content);

      // Полное совпадение
      if (normalizedNew === normalizedExisting) {
        return true;
      }

      // Проверка на схожесть (90%)
      if (this.isSimilarMessage(normalizedNew, normalizedExisting, 0.9)) {
        return true;
      }
    }

    return false;
  }

  async generateBehaviorReport(
    userId: bigint,
    llm: LlmService,
  ): Promise<string> {
    const interactions = await this.prisma.interaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    if (interactions.length === 0) {
      return 'У вас пока нет сохранённых разборов. Напишите боту ситуацию, чтобы начать анализ.';
    }

    const historyText = this.formatInteractionsForReport(interactions);
    const messagesText = await this.getRecentUserMessages(userId, 3);
    const journalText = await this.getJournalEntriesText(userId, 8);
    const userRules = await this.getUserRulesForPrompt(userId);

    const promptTemplate = llm.getPrompt('BEHAVIOR');
    if (!promptTemplate) {
      return 'Ошибка: шаблон отчёта не найден.';
    }

    const prompt = promptTemplate
      .replace('{{RECENT_MESSAGES}}', messagesText)
      .replace('{{JOURNAL_ENTRIES}}', journalText)
      .replace('{{HISTORY}}', historyText)
      .replace('{{USER_RULES}}', userRules);

    return await llm.callLLM([{ role: 'user', content: prompt }], 1000, 0.9);
  }

  private formatInteractionsForReport(interactions: any[]): string {
    if (interactions.length === 0) return '';

    return interactions
      .map((interaction, idx) => {
        try {
          const rawData = JSON.parse(interaction.rawResponse);
          return `Разбор #${idx + 1}:\n${JSON.stringify(rawData, null, 2)}`;
        } catch {
          return `Разбор #${idx + 1}: [ошибка парсинга]`;
        }
      })
      .join('\n\n---\n\n');
  }

  // ==================== RULE ====================

  async getUserRules(userId: bigint) {
    return this.prisma.rule.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getUserRulesForPrompt(userId: bigint): Promise<string> {
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

  async createRule(
    userId: bigint,
    content: string,
    description: string | null,
  ) {
    return this.prisma.rule.create({
      data: {
        userId,
        content,
        description,
      },
    });
  }

  // ==================== JOURNAL ====================

  async getJournalEntriesText(userId: bigint, limit = 20): Promise<string> {
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

  async createJournalEntry(
    userId: bigint,
    sourceMessageId: string,
    messageText: string,
    llm: LlmService,
  ): Promise<void> {
    const trimmed = messageText.trim();

    if (!trimmed || /^\/[a-z0-9_]+/i.test(trimmed)) {
      return;
    }

    try {
      const promptTemplate = llm.getPrompt('JOURNAL');
      if (!promptTemplate) return;

      const prompt = promptTemplate.replace('{{MESSAGE}}', trimmed);

      const rawResponse = await llm.callLLM(
        [{ role: 'user', content: prompt }],
        400,
        0.3,
      );

      let parsed;
      try {
        parsed = JSON.parse(rawResponse);
      } catch {
        this.logger.warn('Не удалось распарсить journal entry:', rawResponse);
        return;
      }

      if (!parsed?.content?.trim()) {
        return;
      }

      await this.prisma.journalEntry.create({
        data: {
          userId,
          sourceMessageId,
          type: parsed.type || 'INSIGHT',
          content: parsed.content.trim(),
          description: parsed.description?.trim() || null,
        },
      });

      this.logger.debug(
        `Создана запись журнала для userId=${userId}: ${parsed.content}`,
      );
    } catch (error) {
      this.logger.error('Ошибка при создании JournalEntry:', error);
    }
  }

  // ==================== DAILY STATS ====================

  async processMessageForDailyStats(
    userId: bigint,
    messageText: string,
    llm: LlmService,
  ): Promise<void> {
    const trimmed = messageText.trim();
    if (!trimmed || /^\/[a-z0-9_]+/i.test(trimmed)) {
      return;
    }

    try {
      const isDuplicate = await this.isDuplicateMessageToday(userId, trimmed);
      if (isDuplicate) {
        this.logger.debug(`Дубликат сообщения пропущен для userId=${userId}`);
        return;
      }

      const promptTemplate = llm.getPrompt('STATS');
      if (!promptTemplate) return;

      const prompt = promptTemplate.replace('{{MESSAGE}}', trimmed);

      const rawResponse = await llm.callLLM(
        [{ role: 'user', content: prompt }],
        400,
        0.2,
      );

      let parsed;
      try {
        parsed = JSON.parse(rawResponse);
      } catch {
        this.logger.warn('Не удалось распарсить daily stats:', rawResponse);
        return;
      }

      if (
        !parsed?.primaryEmotion ||
        !parsed?.topicTag ||
        typeof parsed.typosCount !== 'number' ||
        typeof parsed.sentimentScore !== 'number' ||
        typeof parsed.emotionalIntensity !== 'number'
      ) {
        this.logger.warn('Неполный ответ от LLM для daily stats:', parsed);
        return;
      }

      const messageLength = trimmed.length;
      const wordCount = trimmed.split(/\s+/).filter((w) => w.length > 0).length;
      const typosCount = Math.max(0, Math.round(parsed.typosCount));
      const primaryEmotion = String(parsed.primaryEmotion).toLowerCase();
      const topicTag = String(parsed.topicTag)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
      const sentimentScore = parseFloat(parsed.sentimentScore.toFixed(1));
      const emotionalIntensity = Math.min(
        10,
        Math.max(1, Math.round(parsed.emotionalIntensity)),
      );

      const now = new Date();
      const utcHours = String(now.getUTCHours()).padStart(2, '0');
      const utcMinutes = String(now.getUTCMinutes()).padStart(2, '0');
      const timestampStr = `${utcHours}:${utcMinutes}`;
      const todayStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );

      const existing = await this.prisma.dailyStats.findUnique({
        where: { userId_date: { userId, date: todayStart } },
      });

      if (existing) {
        await this.prisma.dailyStats.update({
          where: { id: existing.id },
          data: {
            messageCount: { increment: 1 },
            totalMessageChars: { increment: messageLength },
            emotions: [...(existing.emotions as string[]), primaryEmotion],
            topics: [...(existing.topics as string[]), topicTag],
            messageTimestamps: [
              ...(existing.messageTimestamps as string[]),
              timestampStr,
            ],
            messageWordCounts: [
              ...(existing.messageWordCounts as number[]),
              wordCount,
            ],
            typosPerMessage: [
              ...(existing.typosPerMessage as number[]),
              typosCount,
            ],
            sentimentScores: [
              ...(existing.sentimentScores as number[]),
              sentimentScore,
            ],
            emotionalIntensities: [
              ...(existing.emotionalIntensities as number[]),
              emotionalIntensity,
            ],
          },
        });
      } else {
        await this.prisma.dailyStats.create({
          data: {
            userId,
            date: todayStart,
            messageCount: 1,
            totalMessageChars: messageLength,
            emotions: [primaryEmotion],
            topics: [topicTag],
            messageTimestamps: [timestampStr],
            messageWordCounts: [wordCount],
            typosPerMessage: [typosCount],
            sentimentScores: [sentimentScore],
            emotionalIntensities: [emotionalIntensity],
          },
        });
      }

      this.logger.debug(`Обновлена дневная статистика для userId=${userId}`);
    } catch (error) {
      this.logger.error('Ошибка при обновлении DailyStats:', error);
    }
  }

  async isDuplicateMessageToday(
    userId: bigint,
    messageText: string,
  ): Promise<boolean> {
    const now = new Date();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const todayEnd = new Date(todayStart);
    todayEnd.setUTCDate(todayEnd.getUTCDate() + 1);

    // Ищем сообщения пользователя за сегодня
    const recentMessages = await this.prisma.message.findMany({
      where: {
        userId,
        sender: 'user',
        createdAt: {
          gte: todayStart,
          lt: todayEnd,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 10, // Проверяем последние 10 сообщений
      select: { content: true, createdAt: true },
    });

    // Нормализуем текст для сравнения (убираем лишние пробелы, приводим к нижнему регистру)
    const normalizedNew = this.normalizeMessageText(messageText);

    for (const msg of recentMessages) {
      const normalizedExisting = this.normalizeMessageText(msg.content);

      // Полное совпадение
      if (normalizedNew === normalizedExisting) {
        return true;
      }

      // Дополнительно: проверяем на очень похожие сообщения (90% совпадения)
      if (this.isSimilarMessage(normalizedNew, normalizedExisting, 0.9)) {
        return true;
      }
    }

    return false;
  }

  // === 🔹 ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ===

  private normalizeMessageText(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ') // Заменяем множественные пробелы на один
      .replace(/[.,!?;:]/g, ''); // Убираем пунктуацию для сравнения
  }

  private isSimilarMessage(
    text1: string,
    text2: string,
    threshold: number,
  ): boolean {
    // Простая проверка на схожесть через длину и включение
    if (text1.length === 0 || text2.length === 0) return false;

    const longer = text1.length > text2.length ? text1 : text2;
    const shorter = text1.length > text2.length ? text2 : text1;

    // Если одно сообщение содержит другое и разница в длине небольшая
    if (longer.includes(shorter) && longer.length / shorter.length < 1.2) {
      return true;
    }

    // Можно добавить более сложную проверку (Levenshtein distance) при необходимости
    return false;
  }

  // ==================== CRON ====================

  async getActiveUsersForCron() {
    return this.prisma.user.findMany({
      where: {
        messages: {
          some: {
            createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        },
      },
      select: { id: true },
    });
  }
}
