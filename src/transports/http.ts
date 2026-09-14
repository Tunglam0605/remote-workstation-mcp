import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import { SERVER_VERSION } from '../capabilities.js';
import { HttpAuthProvider, HttpAuthenticationError, loadHttpAuthFromEnv } from '../security/http-auth.js';
import { runAsPrincipal } from '../security/request-principal.js';
import type { McpServerFactory, TransportDescriptor, TransportProvider } from './types.js';

export interface LoopbackHttpTransportOptions {
  port?: number;
  auth?: HttpAuthProvider;
}

function configuredPort(value: number | undefined): number {
  const port = value ?? Number(process.env.RWMCP_PORT ?? 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('RWMCP_PORT must be a valid TCP port.');
  }
  return port;
}

export class LoopbackHttpTransportProvider implements TransportProvider {
  readonly descriptor: TransportDescriptor;
  private readonly port: number;
  private readonly auth: HttpAuthProvider;

  constructor(private readonly context: AppContext, options: LoopbackHttpTransportOptions = {}) {
    this.port = configuredPort(options.port);
    this.auth = options.auth ?? new HttpAuthProvider(loadHttpAuthFromEnv());
    this.descriptor = {
      id: 'http-loopback',
      protocol: 'streamable-http',
      exposure: 'loopback',
      authentication: this.auth.config.mode,
      endpoint: `http://127.0.0.1:${this.port}/mcp`
    };
  }

  async start(factory: McpServerFactory): Promise<void> {
    const app = createMcpExpressApp();
    const nodeHandler = toNodeHandler(createMcpHandler(factory));

    app.get('/', (_req, res) => res.json({
      name: 'remote-workstation-mcp',
      version: SERVER_VERSION,
      mcp: '/mcp',
      health: '/healthz',
      transport: this.descriptor.id,
      httpAuth: this.auth.config.mode
    }));

    app.get('/healthz', (_req, res) => res.json({
      ok: true,
      version: SERVER_VERSION,
      mode: this.context.policy.effectiveMode(),
      transport: this.descriptor.id,
      httpAuth: this.auth.config.mode
    }));

    app.all('/mcp', (req, res) => {
      try {
        const principal = this.auth.authenticate(req.headers);
        const dispatch = () => nodeHandler(req, res, req.body);
        if (principal) void runAsPrincipal(principal, dispatch);
        else void dispatch();
      } catch (error) {
        if (error instanceof HttpAuthenticationError) {
          res.setHeader('WWW-Authenticate', 'Bearer realm="remote-workstation-mcp"');
          res.status(401).json({ error: 'unauthorized' });
          return;
        }
        throw error;
      }
    });

    await new Promise<void>((resolve, reject) => {
      const httpServer = app.listen(this.port, '127.0.0.1');
      httpServer.once('error', reject);
      httpServer.once('listening', () => {
        console.error(`[remote-workstation-mcp ${SERVER_VERSION}] ${this.descriptor.endpoint} auth=${this.auth.config.mode}`);
        resolve();
      });
    });
  }
}
