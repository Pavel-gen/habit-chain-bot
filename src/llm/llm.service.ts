// src/llm/llm.service.ts
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class LlmService implements OnModuleInit {
  private readonly logger = new Logger(LlmService.name);
  private prompts: Record<string, string> = {};
  private readonly apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
  private readonly apiKey = process.env.OPENROUTER_API_KEY;

  onModuleInit() {
    this.loadPrompts();
  }

  private loadPrompts() {
    const promptFiles = [
      // ✅ ИСПРАВЛЕНО: Добавлено 'src/' в начало путей
      { key: 'DBT', path: 'src/llm/prompts/DBTpromt1.txt' },
      { key: 'BEHAVIOR', path: 'src/llm/prompts/BehaviorAnalysisPrompt.txt' },
      { key: 'CORE', path: 'src/llm/prompts/core_prompt.txt' },
      { key: 'JOURNAL', path: 'src/llm/prompts/message_to_journal.txt' },
      { key: 'STATS', path: 'src/llm/prompts/message_to_daily_stats.txt' },
    ];

    for (const file of promptFiles) {
      try {
        const fullPath = path.join(process.cwd(), file.path);
        this.prompts[file.key] = fs.readFileSync(fullPath, 'utf-8').trim();
        this.logger.log(`Промпт ${file.key} загружен`);
      } catch (error) {
        this.logger.error(`Не удалось загрузить промпт ${file.key}`, error);
        this.prompts[file.key] = ''; // Fallback
      }
    }
  }

  getPrompt(key: string): string {
    return this.prompts[key] || '';
  }

  async callLLM(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    maxTokens = 1000,
    temperature = 0.95,
  ): Promise<string> {
    try {
      const response = await axios.post(
        this.apiUrl,
        {
          model: 'deepseek/deepseek-v3.2',
          messages,
          max_tokens: maxTokens,
          temperature,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://your-bot-url.com', // Требуется OpenRouter
            'X-Title': 'MyBot',
          },
          timeout: 30000, // 30 сек таймаут
        },
      );

      return response.data.choices[0]?.message?.content?.trim() || '...';
    } catch (error) {
      const axiosError = error as AxiosError;
      this.logger.error(
        `LLM Error: ${axiosError.message}`,
        axiosError.response?.data,
      );
      throw new Error('Сервис ИИ временно недоступен');
    }
  }
}
