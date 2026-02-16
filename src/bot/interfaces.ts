// src/bot/types.ts
import { Context, Scenes } from 'telegraf';

interface MySession {
  postAnalysisMode?: boolean;
  lastAnalysisReport?: string;
  coreMode?: boolean;
  awaitingRuleContent?: boolean;
  awaitingRuleDescription?: boolean;
  ruleContent?: string;
}

export type MyContext = Context & { session: MySession };
