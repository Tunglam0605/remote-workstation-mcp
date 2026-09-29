import { InMemoryCertificateKeyPairProvider } from 'node-opcua-common';
import { OPCUAClient, type ClientSession } from 'node-opcua-client';
import { AttributeIds, BrowseDirection } from 'node-opcua-data-model';
import { resolveNodeId } from 'node-opcua-nodeid';
import type { PolicyEngine } from '../../policy.js';

export type OpcUaReadAttribute =
  | 'Value'
  | 'DisplayName'
  | 'BrowseName'
  | 'Description'
  | 'NodeClass'
  | 'DataType'
  | 'ValueRank'
  | 'AccessLevel'
  | 'UserAccessLevel';

export interface OpcUaConnectionOptions {
  timeoutMs?: number;
}

export interface OpcUaReadItem {
  nodeId: string;
  attribute?: OpcUaReadAttribute;
}

const ATTRIBUTE_IDS: Record<OpcUaReadAttribute, number> = {
  Value: AttributeIds.Value,
  DisplayName: AttributeIds.DisplayName,
  BrowseName: AttributeIds.BrowseName,
  Description: AttributeIds.Description,
  NodeClass: AttributeIds.NodeClass,
  DataType: AttributeIds.DataType,
  ValueRank: AttributeIds.ValueRank,
  AccessLevel: AttributeIds.AccessLevel,
  UserAccessLevel: AttributeIds.UserAccessLevel
};

export function validateOpcUaEndpointUrl(value: string): string {
  const endpoint = value.trim();
  if (!endpoint || endpoint.length > 1024) throw new Error('OPC UA endpoint URL must contain 1..1024 characters.');
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('OPC UA endpoint URL is invalid.');
  }
  if (parsed.protocol !== 'opc.tcp:') throw new Error('OPC UA Phase 1 supports only opc.tcp endpoints.');
  if (!parsed.hostname) throw new Error('OPC UA endpoint URL must include a hostname or IP address.');
  if (!parsed.port) throw new Error('OPC UA endpoint URL must include an explicit TCP port.');
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('OPC UA endpoint port must be in range 1..65535.');
  if (parsed.username || parsed.password) throw new Error('OPC UA endpoint URLs must not contain credentials.');
  if (parsed.search || parsed.hash) throw new Error('OPC UA endpoint URLs must not contain query strings or fragments.');
  if (/[\s\0]/.test(endpoint)) throw new Error('OPC UA endpoint URL contains invalid whitespace or null characters.');
  return endpoint;
}

export function validateOpcUaNodeId(value: string): string {
  const nodeId = value.trim();
  if (!nodeId || nodeId.length > 512 || nodeId.includes('\0')) throw new Error('OPC UA NodeId must contain 1..512 non-null characters.');
  try {
    return resolveNodeId(nodeId).toString();
  } catch {
    throw new Error(`Invalid OPC UA NodeId '${nodeId.slice(0, 128)}'.`);
  }
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 250 || value > 30_000) throw new Error('OPC UA timeoutMs must be in range 250..30000.');
  return value;
}

function boundedText(value: unknown, max = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

export function sanitizeOpcUaValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth >= 4) return '[depth-limit]';
  if (typeof value === 'string') return value.length > 4096 ? value.slice(0, 4096) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    const limited = value.subarray(0, 2048);
    return {
      encoding: 'hex',
      bytes: value.length,
      truncated: value.length > limited.length,
      value: limited.toString('hex').toUpperCase()
    };
  }
  if (ArrayBuffer.isView(value)) {
    const array = Array.from(value as unknown as ArrayLike<number>).slice(0, 64);
    return {
      type: value.constructor.name,
      length: (value as unknown as { length?: number }).length ?? array.length,
      truncated: ((value as unknown as { length?: number }).length ?? array.length) > array.length,
      value: array
    };
  }
  if (Array.isArray(value)) {
    return {
      length: value.length,
      truncated: value.length > 64,
      value: value.slice(0, 64).map(item => sanitizeOpcUaValue(item, depth + 1))
    };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 32);
    return Object.fromEntries(entries.map(([key, item]) => [key.slice(0, 128), sanitizeOpcUaValue(item, depth + 1)]));
  }
  return String(value).slice(0, 4096);
}

function createClient(timeoutMs: number): OPCUAClient {
  return OPCUAClient.create({
    applicationName: 'RWMCP OPC UA Diagnostics',
    clientName: 'rwmcp-opcua-readonly',
    endpointMustExist: false,
    keepSessionAlive: false,
    requestedSessionTimeout: Math.max(5_000, Math.min(60_000, timeoutMs * 2)),
    transportTimeout: timeoutMs,
    connectionStrategy: {
      initialDelay: 100,
      maxDelay: 250,
      maxRetry: 0
    },
    securityMode: 'None',
    securityPolicy: 'None',
    certificateKeyPairProvider: new InMemoryCertificateKeyPairProvider()
  });
}

async function withClient<T>(endpointUrl: string, timeoutMs: number, operation: (client: OPCUAClient) => Promise<T>): Promise<T> {
  const client = createClient(timeoutMs);
  try {
    await client.connect(endpointUrl);
    return await operation(client);
  } finally {
    try { await client.disconnect(); } catch { /* best effort disconnect */ }
  }
}

async function withAnonymousSession<T>(
  endpointUrl: string,
  timeoutMs: number,
  operation: (session: ClientSession) => Promise<T>
): Promise<T> {
  return await withClient(endpointUrl, timeoutMs, async client => {
    const session = await client.createSession();
    try {
      return await operation(session);
    } finally {
      try { await session.close(); } catch { /* best effort session close */ }
    }
  });
}

function mapEndpoint(endpoint: any) {
  return {
    endpointUrl: boundedText(endpoint.endpointUrl, 1024),
    securityMode: endpoint.securityMode?.toString?.() ?? String(endpoint.securityMode ?? ''),
    securityPolicyUri: boundedText(endpoint.securityPolicyUri, 512),
    securityLevel: Number(endpoint.securityLevel ?? 0),
    transportProfileUri: boundedText(endpoint.transportProfileUri, 512),
    server: {
      applicationUri: boundedText(endpoint.server?.applicationUri, 512),
      productUri: boundedText(endpoint.server?.productUri, 512),
      applicationName: boundedText(endpoint.server?.applicationName?.text, 512),
      applicationType: endpoint.server?.applicationType?.toString?.() ?? String(endpoint.server?.applicationType ?? '')
    },
    userIdentityTokens: (endpoint.userIdentityTokens ?? []).slice(0, 16).map((token: any) => ({
      policyId: boundedText(token.policyId, 256),
      tokenType: token.tokenType?.toString?.() ?? String(token.tokenType ?? ''),
      issuedTokenType: boundedText(token.issuedTokenType, 512),
      issuerEndpointUrl: boundedText(token.issuerEndpointUrl, 1024),
      securityPolicyUri: boundedText(token.securityPolicyUri, 512)
    }))
  };
}

function mapReference(reference: any) {
  return {
    nodeId: reference.nodeId?.toString?.() ?? String(reference.nodeId ?? ''),
    browseName: reference.browseName?.toString?.() ?? String(reference.browseName ?? ''),
    displayName: boundedText(reference.displayName?.text, 512),
    nodeClass: reference.nodeClass?.toString?.() ?? String(reference.nodeClass ?? ''),
    referenceTypeId: reference.referenceTypeId?.toString?.() ?? String(reference.referenceTypeId ?? ''),
    isForward: Boolean(reference.isForward),
    typeDefinition: reference.typeDefinition?.toString?.() ?? String(reference.typeDefinition ?? '')
  };
}

export class OpcUaAdapter {
  constructor(private readonly policy: PolicyEngine) {}

  async providerStatus() {
    return {
      supported: true,
      backend: 'node-opcua-client',
      sdkVersion: '2.186.9',
      transport: 'opc.tcp',
      authentication: 'anonymous-only',
      securityMode: 'None',
      authority: 'read-only-services',
      localCertificateStorage: 'in-memory-only',
      availableServices: ['GetEndpoints', 'Browse', 'Read'],
      intentionallyUnavailable: [
        'Write',
        'Call',
        'CreateSubscription',
        'MonitoredItem mutation',
        'HistoryUpdate',
        'NodeManagement',
        'username/password identity',
        'certificate enrollment',
        'endpoint discovery scan'
      ]
    };
  }

  async endpointDescribe(endpointUrl: string, options: OpcUaConnectionOptions = {}) {
    this.policy.assertEngineeringExecute();
    const endpoint = validateOpcUaEndpointUrl(endpointUrl);
    const timeoutMs = validateTimeout(options.timeoutMs ?? 5_000);
    const startedAt = Date.now();
    const endpoints = await withClient(endpoint, timeoutMs, async client => await client.getEndpoints());
    const bounded = endpoints.slice(0, 32).map(mapEndpoint);
    return {
      endpointUrl: endpoint,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      endpointCount: endpoints.length,
      truncated: endpoints.length > bounded.length,
      endpoints: bounded
    };
  }

  async browse(
    endpointUrl: string,
    nodeId: string,
    options: OpcUaConnectionOptions & { maxReferences?: number } = {}
  ) {
    this.policy.assertEngineeringExecute();
    const endpoint = validateOpcUaEndpointUrl(endpointUrl);
    const selectedNode = validateOpcUaNodeId(nodeId);
    const timeoutMs = validateTimeout(options.timeoutMs ?? 5_000);
    const maxReferences = options.maxReferences ?? 64;
    if (!Number.isInteger(maxReferences) || maxReferences < 1 || maxReferences > 256) {
      throw new Error('OPC UA maxReferences must be in range 1..256.');
    }

    return await withAnonymousSession(endpoint, timeoutMs, async session => {
      session.requestedMaxReferencesPerNode = maxReferences;
      const result = await session.browse({
        nodeId: resolveNodeId(selectedNode),
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: true,
        nodeClassMask: 0,
        resultMask: 0x3f
      });
      const references = (result.references ?? []).slice(0, maxReferences).map(mapReference);
      return {
        endpointUrl: endpoint,
        nodeId: selectedNode,
        statusCode: result.statusCode?.toString?.() ?? String(result.statusCode ?? ''),
        referenceCount: result.references?.length ?? 0,
        maxReferences,
        truncated: Boolean(result.continuationPoint?.length) || (result.references?.length ?? 0) > references.length,
        continuationPointPresent: Boolean(result.continuationPoint?.length),
        references
      };
    });
  }

  async read(endpointUrl: string, items: OpcUaReadItem[], options: OpcUaConnectionOptions = {}) {
    this.policy.assertEngineeringExecute();
    const endpoint = validateOpcUaEndpointUrl(endpointUrl);
    const timeoutMs = validateTimeout(options.timeoutMs ?? 5_000);
    if (!Array.isArray(items) || items.length < 1 || items.length > 32) throw new Error('OPC UA read accepts 1..32 explicit items.');

    const normalized = items.map(item => {
      const attribute = item.attribute ?? 'Value';
      if (!(attribute in ATTRIBUTE_IDS)) throw new Error(`Unsupported OPC UA read attribute '${String(attribute)}'.`);
      return {
        nodeId: validateOpcUaNodeId(item.nodeId),
        attribute
      };
    });

    return await withAnonymousSession(endpoint, timeoutMs, async session => {
      const dataValues = await session.read(normalized.map(item => ({
        nodeId: resolveNodeId(item.nodeId),
        attributeId: ATTRIBUTE_IDS[item.attribute]
      })), 0);

      const values = normalized.map((item, index) => {
        const dataValue = dataValues[index];
        const variant = dataValue?.value;
        return {
          nodeId: item.nodeId,
          attribute: item.attribute,
          statusCode: dataValue?.statusCode?.toString?.() ?? String(dataValue?.statusCode ?? ''),
          sourceTimestamp: dataValue?.sourceTimestamp?.toISOString?.() ?? null,
          serverTimestamp: dataValue?.serverTimestamp?.toISOString?.() ?? null,
          dataType: variant?.dataType?.toString?.() ?? String(variant?.dataType ?? ''),
          arrayType: variant?.arrayType?.toString?.() ?? String(variant?.arrayType ?? ''),
          value: sanitizeOpcUaValue(variant?.value)
        };
      });

      return {
        endpointUrl: endpoint,
        timeoutMs,
        itemCount: values.length,
        values
      };
    });
  }
}
