// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { AiTestConnectionRequest, AiTestConnectionResponse } from '@diet-app/shared';
import type { Env } from '../config/env.js';
import { outboundRequest } from '../common/outbound-http.js';
import { assertAllowedOllamaUrl, OllamaUrlError, parseAllowedHosts } from './ollama-url.js';

/** Hard ceiling on a single provider probe — a slow/hostile endpoint must not
 *  hold a request slot open for the OS TCP timeout. */
const PROBE_TIMEOUT_MS = 10_000;

/** A list of models is a few kilobytes; a host that sends more is not an Ollama server. */
const PROBE_MAX_BYTES = 1_000_000;

/** OpenRouter's public list of the endpoints that keep no data, with the model each serves; read with no key. */
const NO_RETENTION_LIST = 'https://openrouter.ai/api/v1/endpoints/zdr';

/** How long one reading of that list answers the tests, before it is read again. */
const NO_RETENTION_KEPT_MS = 10 * 60_000;

/** The list was about a megabyte on 2026-11-19; an answer many times that is not read to its end. */
const NO_RETENTION_MAX_BYTES = 16_000_000;

/** What is read of each endpoint of that list: the model it serves, and the provider that runs it. */
const NoRetentionList = z.object({
  data: z.array(z.object({ model_id: z.string(), provider_name: z.string() })),
});

/** What a probe of the provider says, without the providers of the model that keep no data. */
type Probe = Omit<AiTestConnectionResponse, 'noRetentionProviders'>;

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
  /** The last reading of OpenRouter's list of the endpoints that keep no data, and when it was read. */
  private noRetention: { read: number; endpoints: { model: string; provider: string }[] } | null =
    null;

  constructor(private readonly config: ConfigService<Env, true>) {}

  async test(dto: AiTestConnectionRequest): Promise<AiTestConnectionResponse> {
    const [probe, noRetentionProviders] = await Promise.all([
      this.probe(dto),
      this.noRetentionProvidersOf(dto),
    ]);
    return { ...probe, noRetentionProviders };
  }

  /**
   * The providers of the model that keep no data, as OpenRouter's public list
   * has them, when the entry chose them alone: a model with one has nobody to
   * stand in when it is overloaded, and one with none is refused every
   * request. Null where the choice is another, or the list cannot be read.
   */
  private async noRetentionProvidersOf(dto: AiTestConnectionRequest): Promise<string[] | null> {
    const model = dto.model?.trim();
    if (dto.provider !== 'openrouter' || dto.dataPolicy !== 'no_retention' || !model) return null;
    const endpoints = await this.noRetentionEndpoints();
    if (!endpoints) return null;
    return [...new Set(endpoints.filter((e) => e.model === model).map((e) => e.provider))].sort();
  }

  private async noRetentionEndpoints(): Promise<{ model: string; provider: string }[] | null> {
    if (this.noRetention && Date.now() - this.noRetention.read < NO_RETENTION_KEPT_MS) {
      return this.noRetention.endpoints;
    }
    try {
      const res = await fetch(NO_RETENTION_LIST, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const text = await textUpTo(res, NO_RETENTION_MAX_BYTES);
      if (text === null) return null;
      const list = NoRetentionList.safeParse(JSON.parse(text));
      if (!list.success) return null;
      const endpoints = list.data.data.map((row) => ({
        model: row.model_id,
        provider: row.provider_name,
      }));
      this.noRetention = { read: Date.now(), endpoints };
      return endpoints;
    } catch {
      // Not read now: the test says nothing of it, and the next one asks again.
      return null;
    }
  }

  private async probe(dto: AiTestConnectionRequest): Promise<Probe> {
    try {
      switch (dto.provider) {
        case 'openai':
          return await this.testOpenAiCompatible('https://api.openai.com/v1/models', dto.apiKey);
        case 'openrouter':
          return await this.testOpenAiCompatible('https://openrouter.ai/api/v1/models', dto.apiKey);
        case 'ollama':
          return await this.testOllama(dto.baseUrl);
        case 'anthropic':
          return await this.testAnthropic(dto.apiKey, dto.model);
      }
    } catch (err) {
      return { ok: false, models: [], error: describe(err) };
    }
  }

  private async testOpenAiCompatible(url: string, apiKey: string | undefined): Promise<Probe> {
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

  private async testOllama(baseUrl: string | undefined): Promise<Probe> {
    const defaultBaseUrl = this.config.get('OLLAMA_BASE_URL', { infer: true });
    // With no address given, the probe is of the operator's own instance.
    let publicOnly = false;
    if (baseUrl !== undefined) {
      // Guard the user-supplied host against SSRF before any outbound request.
      try {
        publicOnly = assertAllowedOllamaUrl(baseUrl, {
          policy: this.config.get('OLLAMA_USER_POLICY', { infer: true }),
          defaultBaseUrl,
          allowedHosts: parseAllowedHosts(this.config.get('OLLAMA_ALLOWED_HOSTS', { infer: true })),
        }).publicOnly;
      } catch (err) {
        if (err instanceof OllamaUrlError) return { ok: false, models: [], error: err.message };
        throw err;
      }
    }
    const root = baseUrl ?? defaultBaseUrl;
    const res = await outboundRequest(`${root.replace(/\/$/, '')}/api/tags`, {
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
  ): Promise<Probe> {
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

/** The text of an answer, or null when it runs past `maxBytes`: the reading stops there. */
async function textUpTo(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
