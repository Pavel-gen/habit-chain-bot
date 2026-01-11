// src/bot/types.ts
import { Context, Scenes } from 'telegraf';

// 1. Определяем данные сессии (то, что будем хранить)
export interface HabitSessionData {
  step?: number;
  habitName?: string;
}

// 2. Расширяем стандартную сессию сцен
export interface MySceneSession extends Scenes.SceneSessionData {
  // Твои данные → автоматически попадут в ctx.scene.session
  // Но мы будем использовать ctx.session напрямую → поэтому можно оставить пустым
}

// 3. Полная сессия: SceneSession + твои данные
export interface MySession extends Scenes.SceneSession<MySceneSession> {
  // Добавляем свои поля на верхний уровень сессии
  step?: number;
  habitName?: string;
}

// 4. Контекст: Context + session + scene
export interface MyContext extends Context {
  session: MySession;
  scene: Scenes.SceneContextScene<MyContext, MySceneSession>;
}