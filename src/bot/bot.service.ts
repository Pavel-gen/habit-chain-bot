// src/bot/bot.service.ts
import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { Telegraf, session, Scenes, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private bot: Telegraf;
  private logger = new Logger(BotService.name);
  private stage: Scenes.Stage<any>;

  constructor(private prisma: PrismaService) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not defined in .env');
    }
    this.bot = new Telegraf(token);
    this.stage = new Scenes.Stage<any>([]);
    this.registerScenes();
  }

  private registerScenes() {
    // === WizardScene: добавление привычки (2 шага) ===
    const addHabitWizard = new Scenes.WizardScene(
      'ADD_HABIT_SCENE',
      // Шаг 1: запрос названия
      async (ctx: any) => {
        await ctx.replyWithHTML(
          `🤔 <b>Какую активность будем отслеживать?</b>\n\n` +
          `Примеры:\n- Качалка\n- Чтение 20 стр.\n- Пить воду 2л\n\n` +
          `Отправьте /cancel чтобы отменить`
        );
        return ctx.wizard.next();
      },
      // Шаг 2: обработка названия + выбор эмодзи
      async (ctx: any) => {
        // Проверка, что пришло текстовое сообщение
        if (!('message' in ctx.update) || !('text' in ctx.update.message)) {
          await ctx.reply('Пожалуйста, введите название привычки.');
          return;
        }

        const name = ctx.update.message.text.trim();

        // Обработка команд внутри сцены
        if (name.startsWith('/')) {
          if (name === '/cancel') {
            await ctx.scene.leave();
            await ctx.reply('❌ Добавление привычки отменено.');
            return;
          }
          await ctx.reply('Пожалуйста, введите название (не команду).');
          return;
        }

        // Валидация
        if (name.length < 2 || name.length > 50) {
          await ctx.reply('❌ Название должно быть от 2 до 50 символов.');
          return;
        }

        // Сохраняем название в сессии сцены
        ctx.scene.session.habitName = name;

        // Предлагаем выбрать эмодзи
        await ctx.replyWithHTML(
          `🎨 <b>Выберите эмодзи для "${name}"</b>\n\n` +
          `Нажмите на эмодзи или отправьте /skip чтобы пропустить:`,
          Markup.inlineKeyboard([
            [Markup.button.callback('🏋️', 'emoji_🏋️'), Markup.button.callback('📚', 'emoji_📚'), Markup.button.callback('🧘', 'emoji_🧘')],
            [Markup.button.callback('💧', 'emoji_💧'), Markup.button.callback('🏃', 'emoji_🏃'), Markup.button.callback('🍎', 'emoji_🍎')],
            [Markup.button.callback('➡️ Пропустить', 'skip_emoji')]
          ])
        );
      }
    );

    // Обработка callback-кнопок (эмодзи)
    addHabitWizard.action(/emoji_(.+)/, async (ctx: any) => {
      const emoji = ctx.match[1];
      await this.saveHabit(ctx, ctx.scene.session.habitName, emoji);
      return ctx.scene.leave();
    });

    addHabitWizard.action('skip_emoji', async (ctx: any) => {
      await this.saveHabit(ctx, ctx.scene.session.habitName, '');
      return ctx.scene.leave();
    });

    // Команды внутри сцены
    addHabitWizard.command('skip', async (ctx: any) => {
      await this.saveHabit(ctx, ctx.scene.session.habitName, '');
      return ctx.scene.leave();
    });

    addHabitWizard.command('cancel', async (ctx: any) => {
      await ctx.scene.leave();
      await ctx.reply('❌ Добавление привычки отменено.');
    });

    // === Сцена списка (заглушка) ===
    const markHabitsScene = new Scenes.BaseScene('MARK_HABITS_SCENE');
    markHabitsScene.enter(async (ctx: any) => {
      await ctx.reply('⚠️ Сцена отметки привычек пока в разработке');
      await ctx.scene.leave();
    });

    // Регистрация сцен
    this.stage.register(addHabitWizard, markHabitsScene);
  }

  private async saveHabit(ctx: any, name: string, emoji: string) {
    const userId = ctx.from.id.toString();
    try {
      const habit = await this.prisma.habit.create({
        data: { userId, name, emoji },
      });
      await ctx.replyWithHTML(
        `✅ <b>Добавлена активность</b>\n` +
        `"${habit.name}" ${habit.emoji || ''}\n\n` +
        `Теперь отмечай выполнение в /list каждый день!`
      );
    } catch (err) {
      this.logger.error(`Ошибка при сохранении привычки: ${err.message}`);
      await ctx.reply('⚠️ Не удалось сохранить привычку. Попробуйте ещё раз.');
    }
  }

  async onModuleInit() {
    // Middleware: сессии → сцены → команды
    this.bot.use(session());
    this.bot.use(this.stage.middleware());

    // Глобальная команда /cancel
    this.bot.command('cancel', async (ctx: any) => {
      if (ctx.scene?.current) {
        await ctx.scene.leave();
        await ctx.reply('❌ Все действия отменены.');
      }
    });

    // Основные команды
    this.bot.command('start', async (ctx: any) => {
      await this.ensureUserExists(ctx.from.id);
      await ctx.replyWithHTML(
        `🏆 <b>HabitChain</b>\n` +
        `Твои цепочки привычек\n\n` +
        `Команды:\n` +
        `/add - Добавить активность\n` +
        `/list - Мои активности\n` +
        `/progress - Посмотреть прогресс`
      );
    });

    this.bot.command('add', async (ctx: any) => {
      await this.ensureUserExists(ctx.from.id);
      await ctx.scene.enter('ADD_HABIT_SCENE');
    });

    this.bot.command('list', async (ctx: any) => {
      await this.ensureUserExists(ctx.from.id);
      await ctx.scene.enter('MARK_HABITS_SCENE');
    });

    this.bot.command('progress', (ctx: any) => {
      ctx.reply('📊 ВАШ ПРОГРЕСС\n\n⚠️ Функция в разработке.');
    });

    // Запуск
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

  private async ensureUserExists(telegramId: bigint | number): Promise<void> {
    const id = telegramId.toString();
    await this.prisma.user.upsert({
      where: { id },
      update: {},
      create: { id },
    });
  }
}