// src/bot/bot.service.ts
import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
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
            `Отправьте /cancel чтобы отменить`,
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
            [
              Markup.button.callback('🏋️', 'emoji_🏋️'),
              Markup.button.callback('📚', 'emoji_📚'),
              Markup.button.callback('🧘', 'emoji_🧘'),
            ],
            [
              Markup.button.callback('💧', 'emoji_💧'),
              Markup.button.callback('🏃', 'emoji_🏃'),
              Markup.button.callback('🍎', 'emoji_🍎'),
            ],
            [Markup.button.callback('➡️ Пропустить', 'skip_emoji')],
          ]),
        );
      },
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
    const markHabitsWizard = new Scenes.WizardScene(
      'MARK_HABITS_SCENE',
      async (ctx: any) => {
        await this.showHabitsList(ctx);
      },
    );

    // Обработка нажатия на кнопку привычки
    markHabitsWizard.action(/toggle_habit_(\d+)/, async (ctx: any) => {
      const habitId = parseInt(ctx.match[1], 10);
      await this.toggleHabitRecord(ctx, habitId);
      await this.showHabitsList(ctx); // обновляем список
    });

    markHabitsWizard.action('cancel_list', async (ctx: any) => {
      await ctx.scene.leave();
      await ctx.reply('❌ Вы вышли из режима отметки привычек.');
    });

    // Обработка команды /cancel внутри сцены
    markHabitsWizard.command('cancel', async (ctx: any) => {
      await ctx.scene.leave();
      await ctx.reply('❌ Отметка привычек отменена.');
    });

    const progressWizard = new Scenes.WizardScene(
      'PROGRESS_SCENE',
      async (ctx: any) => {
        const userId = ctx.from.id.toString();
        const habits = await this.prisma.habit.findMany({
          where: { userId },
          orderBy: { createdAt: 'asc' },
        });

        if (habits.length === 0) {
          await ctx.reply('📭 У вас нет активностей. Добавьте через /add');
          return ctx.scene.leave();
        }

        let text = `📊 <b>Выберите активность для просмотра прогресса:</b>\n\n`;
        const buttons: any[] = [];

        habits.forEach((habit) => {
          text += `${habit.emoji || ''} ${habit.name}\n`;
          buttons.push(
            Markup.button.callback(
              `${habit.emoji || ''} ${habit.name}`,
              `view_progress_${habit.id}`,
            ),
          );
        });

        await ctx.replyWithHTML(
          text,
          Markup.inlineKeyboard(buttons.map((b) => [b])),
        );
        return ctx.wizard.next();
      },

      async (ctx: any) => {
        await ctx.reply('Загрузка прогресса...');
        await ctx.scene.leave();
      },
    );

    progressWizard.command('cancel', async (ctx: any) => {
      await ctx.scene.leave();
      await ctx.reply('❌ Отметка привычек отменена.');
    });

    progressWizard.action(/view_progress_(\d+)/, async (ctx: any) => {
      const habitId = parseInt(ctx.match[1], 10);
      const userId = ctx.from.id.toString();

      // Проверяем, что привычка принадлежит пользователю
      const habit = await this.prisma.habit.findFirst({
        where: { id: habitId, userId },
        include: { records: true },
      });

      if (!habit) {
        await ctx.answerCbQuery('⚠️ Привычка не найдена.', true);
        return;
      }

      // Генерируем календарь за текущий месяц
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth(); // 0-based

      // Первый и последний день месяца
      const firstDay = new Date(year, month, 1);
      const lastDay = new Date(year, month + 1, 0);

      // Все дни месяца
      const daysInMonth: any[] = [];
      for (let d = firstDay.getDate(); d <= lastDay.getDate(); d++) {
        daysInMonth.push(new Date(year, month, d));
      }

      // Преобразуем записи в Map для быстрого поиска
      const recordMap = new Map<string, boolean>();
      habit.records.forEach((record) => {
        const dateStr = record.date.toISOString().split('T')[0];
        recordMap.set(dateStr, record.done);
      });

      // Заголовок календаря
      const monthNames = [
        'Январь',
        'Февраль',
        'Март',
        'Апрель',
        'Май',
        'Июнь',
        'Июль',
        'Август',
        'Сентябрь',
        'Октябрь',
        'Ноябрь',
        'Декабрь',
      ];
      let calendarText = `<b>${habit.emoji || ''} ${habit.name}</b>\n\n`;
      calendarText += `📅 ${monthNames[month]} ${year}\n\n`;

      // Дни недели
      calendarText += 'Пн Вт Ср Чт Пт Сб Вс\n';

      // Заполняем календарь
      let weekLine = '';
      let dayOfWeek = firstDay.getDay(); // 0 = воскресенье
      if (dayOfWeek === 0) dayOfWeek = 7; // делаем понедельник = 1

      // Пробелы до первого дня
      for (let i = 1; i < dayOfWeek; i++) {
        weekLine += '   ';
      }

      daysInMonth.forEach((date) => {
        const dateStr = date.toISOString().split('T')[0];
        const todayStr = now.toISOString().split('T')[0];

        let symbol = '  '; // до начала трекинга

        if (dateStr < habit.createdAt.toISOString().split('T')[0]) {
          symbol = '  '; // ещё не начал трекать
        } else if (dateStr === todayStr) {
          symbol = '⏳';
        } else if (date > now) {
          symbol = '  '; // будущее — не показываем
        } else {
          const done = recordMap.get(dateStr);
          symbol = done ? '✅' : '❌';
        }

        weekLine += symbol.padEnd(3, ' ');

        // Новая строка каждые 7 дней
        if (date.getDay() === 0 || date.getDate() === daysInMonth.length) {
          calendarText += weekLine.trimEnd() + '\n';
          weekLine = '';
        }
      });

      // Статистика
      const totalDaysTracked = habit.records.length;
      const completedDays = habit.records.filter((r) => r.done).length;
      const missedDays = totalDaysTracked - completedDays;
      const completionRate =
        totalDaysTracked > 0
          ? Math.round((completedDays / totalDaysTracked) * 100)
          : 0;

      calendarText += `\nСтатистика:\n`;
      calendarText += `Всего дней: ${totalDaysTracked}\n`;
      calendarText += `Выполнено: ${completedDays} (${completionRate}%)\n`;
      calendarText += `Пропущено: ${missedDays} (${100 - completionRate}%)\n\n`;
      calendarText += `Легенда:\n✅ — сделано\n❌ — пропущено\n⏳ — сегодня`;

      await ctx.editMessageText(calendarText, { parse_mode: 'HTML' });
      await ctx.answerCbQuery();
    });

    // Регистрация сцен
    this.stage.register(addHabitWizard, markHabitsWizard, progressWizard);
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
          `Теперь отмечай выполнение в /list каждый день!`,
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
          `/progress - Посмотреть прогресс`,
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

    this.bot.command('progress', async (ctx: any) => {
      await this.ensureUserExists(ctx.from.id);
      await ctx.scene.enter('PROGRESS_SCENE');
      // ctx.reply('📊 ВАШ ПРОГРЕСС\n\n⚠️ Функция в разработке.');
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

  private async showHabitsList(ctx: any) {
    const userId = ctx.from.id.toString();
    const today = new Date();
    today.setHours(0, 0, 0, 0); // начало дня

    // Получаем все привычки + записи за сегодня
    const habits = await this.prisma.habit.findMany({
      where: { userId },
      include: {
        records: {
          where: { date: today },
        },
      },
    });

    if (habits.length === 0) {
      await ctx.reply('📭 У вас пока нет активностей. Добавьте через /add');
      await ctx.scene.leave();
      return;
    }

    let text = `📆 <b>Сегодня, ${today.toLocaleDateString('ru-RU')}</b>\n\n`;
    const buttons: any[] = [];

    for (const habit of habits) {
      const record = habit.records[0]; // максимум одна запись за день (unique constraint)
      const done = record?.done ?? false;
      const mark = done ? '✅' : '❌';
      text += `${mark} ${habit.emoji || ''} ${habit.name}\n`;

      // Кнопка для переключения
      buttons.push(
        Markup.button.callback(
          `${done ? '✅' : '⬜'} ${habit.name}`,
          `toggle_habit_${habit.id}`,
        ),
      );
    }

    buttons.push(Markup.button.callback('❌ Отмена', 'cancel_list'));

    text += `\nНажмите на привычку, чтобы отметить/снять отметку.`;

    // Группируем кнопки по 1 в строке (можно по 2, если короткие названия)
    const keyboard = Markup.inlineKeyboard(buttons.map((b) => [b]));

    // Редактируем сообщение, если оно уже есть; иначе отправляем новое
    if (ctx.wizard.state.messageId) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
        return;
      } catch (e) {
        // Игнорируем ошибку "message not modified"
      }
    }

    const sent = await ctx.replyWithHTML(text, keyboard);
    ctx.wizard.state.messageId = sent.message_id;
  }

  private async toggleHabitRecord(ctx: any, habitId: number) {
    const userId = ctx.from.id.toString();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Проверяем, принадлежит ли привычка пользователю
    const habit = await this.prisma.habit.findFirst({
      where: { id: habitId, userId },
    });

    if (!habit) {
      await ctx.answerCbQuery('⚠️ Привычка не найдена.', true);
      return;
    }

    // Находим или создаём запись на сегодня
    const existingRecord = await this.prisma.habitRecord.findUnique({
      where: { habitId_date: { habitId, date: today } },
    });

    if (existingRecord) {
      // Переключаем статус
      const newDone = !existingRecord.done;
      await this.prisma.habitRecord.update({
        where: { id: existingRecord.id },
        data: { done: newDone },
      });
    } else {
      // Создаём новую запись (по умолчанию done = false → сразу делаем true)
      await this.prisma.habitRecord.create({
        data: { habitId, date: today, done: true },
      });
    }

    await ctx.answerCbQuery(); // подтверждаем нажатие
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
