// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The one way this application talks to an Ollama server.
 *
 * An Ollama address can come from a user, so the request is made with care:
 * it never follows a redirect (a server that answers 3xx is not followed to
 * wherever it points), it stops reading a body that grows past a limit, it
 * gives up after a deadline, and when the caller asks for it, it connects
 * only to public addresses. That last check happens on the addresses the
 * name resolves to at the moment of connecting, and the connection goes to
 * the address that was checked, so a name cannot pass as public and then
 * resolve to something internal.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isPublicAddress } from './ollama-url.js';

export interface OllamaRequest {
  method: 'GET' | 'POST';
  /** Sent as JSON. */
  body?: unknown;
  timeoutMs: number;
  /** The largest response body that is read. */
  maxBytes: number;
  /** Refuse to connect unless every address the host resolves to is public. */
  publicOnly: boolean;
}

export interface OllamaResponse {
  status: number;
  statusText: string;
  text: string;
}

export type OllamaFailure = 'timeout' | 'too_large' | 'address_not_public' | 'network';

export class OllamaRequestError extends Error {
  constructor(
    readonly failure: OllamaFailure,
    message: string,
  ) {
    super(message);
    this.name = 'OllamaRequestError';
  }
}

/** How a host name is turned into addresses; `dns.lookup` unless a test supplies its own. */
export type Resolver = (
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for the socket that resolves the name once, refuses the
 * connection if any of the addresses is not public, and hands back only what
 * it checked.
 */
function publicLookup(resolve: Resolver) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const internal = addresses.find((entry) => !isPublicAddress(entry.address));
      if (internal || addresses.length === 0) {
        return callback(
          new OllamaRequestError('address_not_public', `${hostname} does not resolve to a public address.`),
          [],
        );
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

export function ollamaRequest(
  url: string,
  req: OllamaRequest,
  resolve: Resolver = dnsLookup as Resolver,
): Promise<OllamaResponse> {
  return new Promise((done, fail) => {
    const target = new URL(url);
    const body = req.body === undefined ? undefined : JSON.stringify(req.body);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

    let settled = false;
    const finish = (outcome: OllamaResponse | OllamaRequestError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome instanceof OllamaRequestError) fail(outcome);
      else done(outcome);
    };

    const request = send(
      target,
      {
        method: req.method,
        // One connection per request: nothing is reused from an earlier call
        // that was made on other terms.
        agent: false,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        ...(req.publicOnly ? { lookup: publicLookup(resolve) } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > req.maxBytes) {
            request.destroy();
            finish(new OllamaRequestError('too_large', `The server sent more than ${req.maxBytes} bytes; the reply was discarded.`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          finish({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', (err) => finish(new OllamaRequestError('network', err.message)));
      },
    );

    const timer = setTimeout(() => {
      request.destroy();
      finish(new OllamaRequestError('timeout', `No answer within ${Math.round(req.timeoutMs / 1000)} s.`));
    }, req.timeoutMs);

    request.on('error', (err) => {
      finish(err instanceof OllamaRequestError ? err : new OllamaRequestError('network', err.message));
    });
    request.end(body);
  });
}
