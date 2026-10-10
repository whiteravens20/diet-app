// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { AiController } from './ai.controller.js';
import { AiKeyService } from './ai-key.service.js';
import { AiQuotaService } from './ai-quota.service.js';
import { AiRouterService } from './ai-router.service.js';
import { AiTestService } from './ai-test.service.js';
import { AnthropicProvider } from './providers/anthropic.provider.js';
import { OllamaProvider } from './providers/ollama.provider.js';
import { OpenAiProvider } from './providers/openai.provider.js';
import { OpenRouterProvider } from './providers/openrouter.provider.js';

/**
 * AI orchestration: provider abstraction, encrypted key store, failover router
 * and the usage log with its allowances. Exported services are consumed by the
 * recipe / meal-plan modules, which check what a model answered themselves.
 */
@Module({
  controllers: [AiController],
  providers: [
    AiKeyService,
    AiQuotaService,
    AiRouterService,
    AiTestService,
    OpenAiProvider,
    AnthropicProvider,
    OpenRouterProvider,
    OllamaProvider,
  ],
  exports: [
    AiKeyService,
    AiQuotaService,
    AiRouterService,
    // Exported so the admin curation runners can call a provider directly
    // with the AI_DEFAULT_PROVIDER / AI_DEFAULT_MODEL env config: env-driven,
    // not DB-driven.
    OpenAiProvider,
    AnthropicProvider,
    OpenRouterProvider,
    OllamaProvider,
  ],
})
export class AiModule {}
