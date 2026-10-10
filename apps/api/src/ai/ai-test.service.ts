// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiTestConnectionRequest, AiTestConnectionResponse } from '@diet-app/shared';
import type { Env } from '../config/env.js';
import { ollamaRequest } from './ollama-http.js';
import { assertAllowedOllamaUrl, OllamaUrlError, parseAllowedHosts } from './ollama-url.js';

/** Hard ceiling on a single provider probe — a slow/hostile endpoint must not
 *  hold a request slot open for the OS TCP timeout. */
const PROBE_TIMEOUT_MS = 10_000;

/** A list of models is a few kilobytes; a host that sends more is not an Ollama server. */
const PROBE_MAX_BYTES = 1_000_000;

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
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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
    const defaultBaseUrl = this.config.get('OLLAMA_BASE_URL', { infer: true });
    // With no address given, the probe is of the operator's own instance.
    let publicOnly = false;
    if (baseUrl !== undefined) {
      // Guard the user-supplied host against SSRF before any outbound request.
      try {
        publicOnly = assertAllowedOllamaUrl(baseUrl, {
          policy: this.config.get('OLLAMA_USER_POLICY', { infer: true }),
          defaultBaseUrl,
          allowedHosts: parseAllowedHosts(
            this.config.get('OLLAMA_ALLOWED_HOSTS', { infer: true }),
          ),
        }).publicOnly;
      } catch (err) {
        if (err instanceof OllamaUrlError) return { ok: false, models: [], error: err.message };
        throw err;
      }
    }
    const root = baseUrl ?? defaultBaseUrl;
    const res = await ollamaRequest(`${root.replace(/\/$/, '')}/api/tags`, {
      method: 'GET',
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: PROBE_MAX_BYTES,
      publicOnly,
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, models: [], error: `HTTP ${res.status} ${res.statusText}` };
    }
    let body: { models?: Array<{ name?: string }> };
    try {
      body = JSON.parse(res.text) as { models?: Array<{ name?: string }> };
    } catch {
      // What the host sent is not repeated: it is not ours to show.
      return { ok: false, models: [], error: 'The host answered, but not as an Ollama server.' };
    }
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
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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
