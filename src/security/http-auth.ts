import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { RequestPrincipal } from './request-principal.js';

export type HttpAuthMode = 'none' | 'bearer';

export interface HttpAuthConfig {
  mode: HttpAuthMode;
  token?: string;
  principalId: string;
  principalType: string;
  scopes: string[];
}

export class HttpAuthenticationError extends Error {
  readonly statusCode = 401;
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'HttpAuthenticationError';
  }
}

function parseScopes(raw: string | undefined): string[] {
  const scopes = (raw ?? 'workstation.read')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  return [...new Set(scopes)];
}

export function loadHttpAuthFromEnv(env: NodeJS.ProcessEnv = process.env): HttpAuthConfig {
  const rawMode = (env.RWMCP_HTTP_AUTH_MODE ?? 'none').trim().toLowerCase();
  if (rawMode !== 'none' && rawMode !== 'bearer') {
    throw new Error("RWMCP_HTTP_AUTH_MODE must be 'none' or 'bearer'.");
  }
  const mode = rawMode as HttpAuthMode;
  const token = env.RWMCP_HTTP_BEARER_TOKEN?.trim();
  if (mode === 'bearer' && !token) {
    throw new Error('RWMCP_HTTP_BEARER_TOKEN is required when RWMCP_HTTP_AUTH_MODE=bearer.');
  }
  if (token && token.length < 32) {
    throw new Error('RWMCP_HTTP_BEARER_TOKEN must be at least 32 characters.');
  }
  return {
    mode,
    token,
    principalId: env.RWMCP_HTTP_PRINCIPAL_ID?.trim() || 'http-client',
    principalType: env.RWMCP_HTTP_PRINCIPAL_TYPE?.trim() || 'mcp-http',
    scopes: parseScopes(env.RWMCP_HTTP_SCOPES)
  };
}

function secureEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export class HttpAuthProvider {
  constructor(readonly config: HttpAuthConfig) {}

  authenticate(headers: IncomingHttpHeaders): RequestPrincipal | undefined {
    if (this.config.mode === 'none') return undefined;

    const authorization = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new HttpAuthenticationError();
    const actual = authorization.slice('Bearer '.length);
    if (!this.config.token || !secureEqual(actual, this.config.token)) throw new HttpAuthenticationError();

    return {
      id: this.config.principalId,
      type: this.config.principalType,
      scopes: this.config.scopes,
      authenticated: true
    };
  }
}
