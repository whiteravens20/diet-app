import { Module } from '@nestjs/common';
import { AiController } from './ai.controller.js';
import { AiKeyService } from './ai-key.service.js';
import { AiRouterService } from './ai-router.service.js';
import { AiValidationService } from './ai-validation.service.js';
import { AnthropicProvider } from './providers/anthropic.provider.js';
import { OllamaProvider } from './providers/ollama.provider.js';
import { OpenAiProvider } from './providers/openai.provider.js';
import { OpenRouterProvider } from './providers/openrouter.provider.js';

/**
 * AI orchestration: provider abstraction, encrypted key store, failover router
 * and the deterministic validation layer. Exported services are consumed by the
 * recipe / meal-plan modules.
 */
@Module({
  controllers: [AiController],
  providers: [
    AiKeyService,
    AiRouterService,
    AiValidationService,
    OpenAiProvider,
    AnthropicProvider,
    OpenRouterProvider,
    OllamaProvider,
  ],
  exports: [
    AiKeyService,
    AiRouterService,
    AiValidationService,
    // Exported so the admin auto-translate runner can call a provider
    // directly with the AI_DEFAULT_PROVIDER / AI_DEFAULT_MODEL env config —
    // env-driven, not DB-driven, see F14 / B.6.1.
    OpenAiProvider,
    AnthropicProvider,
    OpenRouterProvider,
    OllamaProvider,
  ],
})
export class AiModule {}
