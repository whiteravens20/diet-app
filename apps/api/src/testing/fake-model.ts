// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A scriptable stand-in for an Ollama server. The test application points
 * `OLLAMA_BASE_URL` at it, so the real adapter, router, quota and parsers run
 * against replies a test chooses: correct, malformed, oversized, slow, failing.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One scripted answer. Replies are served oldest first. */
export interface ModelReply {
  /** Only answer a request whose model name or prompt contains this text. */
  match?: string;
  /** The text the model "says", or a function of the request that produces it. */
  text?: string | ((request: ModelRequest) => string);
  /** Answer as a model does when it runs into its token limit. */
  truncated?: boolean;
  /** A status other than 200 makes the call fail like a provider error. */
  status?: number;
  delayMs?: number;
  /** How many requests this reply serves before it is used up (default 1). */
  times?: number;
}

/** What the application sent to the model. */
export interface ModelRequest {
  model: string;
  prompt: string;
  format?: string;
  /** The limits the application put on the answer. */
  maxTokens?: number;
  temperature?: number;
}

export interface FakeModel {
  readonly url: string;
  /** Every chat request received, in order. */
  readonly requests: ModelRequest[];
  reply(rule: ModelReply): void;
  /** Drop scripted replies and the request log. */
  reset(): void;
  close(): Promise<void>;
}

type QueuedReply = ModelReply & { times: number };

/** The answer when nothing was scripted: not JSON, so a parser takes its fallback path. */
export const UNSCRIPTED_REPLY = 'no reply was scripted for this request';

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export async function startFakeModel(): Promise<FakeModel> {
  let rules: QueuedReply[] = [];
  const requests: ModelRequest[] = [];

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/api/tags') {
      send(200, { models: [{ name: 'test-model' }] });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/chat') {
      send(404, { error: 'not found' });
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          model?: string;
          format?: string;
          messages?: { content: string }[];
          options?: { num_predict?: number; temperature?: number };
        };
        const prompt = (body.messages ?? []).map((m) => m.content).join('\n');
        const received: ModelRequest = {
          model: body.model ?? '',
          prompt,
          format: body.format,
          maxTokens: body.options?.num_predict,
          temperature: body.options?.temperature,
        };
        requests.push(received);

        const haystack = `${body.model ?? ''}\n${prompt}`;
        const index = rules.findIndex((rule) => !rule.match || haystack.includes(rule.match));
        const rule = index === -1 ? undefined : rules[index];
        if (rule) {
          rule.times -= 1;
          if (rule.times <= 0) rules.splice(index, 1);
          if (rule.delayMs) await sleep(rule.delayMs);
        }
        const text = typeof rule?.text === 'function' ? rule.text(received) : rule?.text;
        if (rule?.status && rule.status !== 200) {
          send(rule.status, text ?? 'scripted failure');
          return;
        }
        send(200, {
          model: body.model,
          message: { role: 'assistant', content: rule ? (text ?? '') : UNSCRIPTED_REPLY },
          done: true,
          done_reason: rule?.truncated ? 'length' : 'stop',
          prompt_eval_count: 1,
          eval_count: 1,
        });
      })();
    });
  });

  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reply(rule) {
      rules.push({ ...rule, times: rule.times ?? 1 });
    },
    reset() {
      rules = [];
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((closed, failed) => {
        server.closeAllConnections();
        server.close((err) => (err ? failed(err) : closed()));
      }),
  };
}
