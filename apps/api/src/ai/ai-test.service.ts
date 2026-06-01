import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiTestConnectionRequest, AiTestConnectionResponse } from '@diet-app/shared';
import type { Env } from '../config/env.js';

/**
 * Test-connection probe behind `POST /ai/test`.
 *
 * Hits the provider's models-list endpoint with the supplied credentials —
 * the Settings AI card uses this to verify a key and populate the model
 * dropdown before saving. The probe never persists the credential.
 *
 * Provider quirks:
 * - OpenAI / OpenRouter expose `/v1/models` returning `{ data: [{ id }] }`.
 * - Ollama exposes `/api/tags` returning `{ models: [{ name }] }`.
 * - Anthropic has no public models-list endpoint; we send a tiny
 *   `messages.create` ping and treat HTTP 200 as success. The caller must
 *   supply a `model` so the probe knows what to ping.
 */
@Injectable()
export class AiTestService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async test(dto: AiTestConnectionRequest): Promise<AiTestConnectionResponse> {
    try {
      switch (dto.provider) {
        case 'openai':
          return await this.testOpenAiCompatible(
            'https://api.openai.com/v1/models',
            dto.apiKey,
          );
        case 'openrouter':
          return await this.testOpenAiCompatible(
            'https://openrouter.ai/api/v1/models',
            dto.apiKey,
          );
        case 'ollama':
          return await this.testOllama(dto.baseUrl);
        case 'anthropic':
          return await this.testAnthropic(dto.apiKey, dto.model);
      }
    } catch (err) {
      return { ok: false, models: [], error: describe(err) };
    }
  }

  private async testOpenAiCompatible(
    url: string,
    apiKey: string | undefined,
  ): Promise<AiTestConnectionResponse> {
    if (!apiKey) return { ok: false, models: [], error: 'API key required.' };
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return { ok: false, models: [], error: `HTTP ${res.status} ${res.statusText}` };
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
      .sort();
    return { ok: true, models, error: null };
  }

  private async testOllama(baseUrl: string | undefined): Promise<AiTestConnectionResponse> {
    const root = baseUrl ?? this.config.get('OLLAMA_BASE_URL', { infer: true });
    if (!root) return { ok: false, models: [], error: 'OLLAMA_BASE_URL not configured.' };
    const res = await fetch(`${root.replace(/\/$/, '')}/api/tags`);
    if (!res.ok) {
      return { ok: false, models: [], error: `HTTP ${res.status} ${res.statusText}` };
    }
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (body.models ?? [])
      .map((m) => m.name)
      .filter((name): name is string => typeof name === 'string')
      .sort();
    return { ok: true, models, error: null };
  }

  private async testAnthropic(
    apiKey: string | undefined,
    model: string | undefined,
  ): Promise<AiTestConnectionResponse> {
    if (!apiKey) return { ok: false, models: [], error: 'API key required.' };
    if (!model) {
      return { ok: false, models: [], error: 'Model id required to probe Anthropic.' };
    }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, models: [], error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, models: [], error: null };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
