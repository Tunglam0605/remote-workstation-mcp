# Control Center backend API inventory

Canonical source inspected read-only: the repository at `cdd91bf0341f500dd1c95188e93c60f0531e2fcd` (`v0.30.0`).  Route dispatcher: `src/setup/setup-server.ts:1020-1693`.

## Integration boundary

All API calls require:

- loopback client address (`127.0.0.1`, `::1`, or mapped loopback), source `setup-server.ts:1020-1022`;
- an allowed same-origin request, `:1024-1026`;
- `x-rwmcp-setup-token` equal to the ephemeral page token, `:1047-1049`.

The new vanilla Moonlight UI must retain the token header and use same-origin fetch. JSON request bodies are limited to 64 KiB (`:64`, `:92-103`). Responses are JSON/no-store. Any thrown route error becomes `400 { error: string }` (`:1690-1693`); authorization failures are `403 { error }`.

## Status, runtime, tunnel, and host surface

| Method / route | Request | Successful response / dependable fields | Source |
|---|---|---|---|
| `GET /api/status` | none | `{version, identity:{id,name,…}, recommendedAppName, platform, nodeVersion, settings, settingsPersisted, runtimeApiKeyStored, onboardingRequired, tunnelClientInstalled, workspaceExists, configuredPortAvailable, configuredPortFree, configuredPortOwnedByManagedRuntime, recommendedMcpPort}`. `settings` includes `mcpPort`, `controlPort`, `workspaceRoot`, `tunnelId`, `organizationId`, `cloudflaredManaged`, `httpScopes`, `execution`. | `setup-server.ts:1052-1087`; settings schema `settings.ts:46-68` |
| `GET /api/recovery/status` | none | Status-compatible fallback plus `recoveryMode:true`, `localControlCenter:'ONLINE'`; port availability is deliberately optimistic. | `setup-server.ts:1090-1113` |
| `GET /api/runtime/status` | none | Platform runtime status. Windows fields: `{running,pid?,mode?,root,port,mcpHealthy,mcpVersion?,httpAuth?,tunnelReady,connectionState:'ONLINE'|'OFFLINE'|'RECONNECTING',connectionReason?,connectionUpdatedAt?,reconnectAttempt,startupRegistered,startupMethod?,stdoutLog,stderrLog}`. Fallback on probe failure: `{supported:true,running:false,mcpHealthy:false,tunnelReady:false,connectionState:'OFFLINE',connectionReason:'runtime-control-unavailable',error}`. | `setup-server.ts:488-501,1616-1619`; Windows producer `scripts/runtime-control-windows.ps1:245-297` |
| `POST /api/runtime/action` | `{action:'Start'|'Stop'|'Restart'|'RegisterStartup'|'UnregisterStartup', mode?:'Local'|'OpenAI'}`; omitted/non-Local mode becomes OpenAI. | Runtime status object. Windows `Restart` is async: `202` with the restart scheduler result; all other actions return `200`. | `setup-server.ts:1621-1632` |
| `POST /api/recovery/test` | `{tunnelId?:string,runtimeApiKey?:string}` | `{ok:boolean,tunnelId,message}`. It validates the tunnel id and uses pasted key only for that probe. | `setup-server.ts:503-525,1122-1128` |
| `POST /api/recovery/apply` | `{tunnelId?:string,organizationId?:string,runtimeApiKey?:string,reconnect?:boolean}` | `{ok:true,settings,runtimeApiKeyStored,reconnectAccepted,restart}`. `reconnect` defaults true. | `setup-server.ts:1130-1155` |
| `POST /api/bootstrap` | `{tunnelId:string,runtimeApiKey:string}` | Bootstrap result consumed by legacy UI as at least `{ready:boolean}`. | `setup-server.ts:1115-1120`; UI `ui.ts:546` |
| `POST /api/save` | `{mcpPort,controlPort?,workspaceRoot,tunnelId?,organizationId?,cloudflaredManaged?,httpScopes?,runtimeApiKey?,storeRuntimeApiKey?}` | `{ok:true,message,runtimeApiKeyStored}`. A supplied runtime key must be persistable; never echo it. | `setup-server.ts:1634-1677` |
| `DELETE /api/runtime-key` | none | `{ok:true}` | `setup-server.ts:1679-1683` |
| `POST /api/install-tunnel-client` | none | `{ok:true,output}` (installer log text) | `setup-server.ts:1685-1688` |

The server does **not** expose a separate detailed tunnel endpoint or live host-health endpoint. Tunnel state is only `runtime.tunnelReady` plus `connection*`; configured SSH hosts appear only as pairing `bootstrapHosts`. This is a telemetry gap for a richer overview.

## Codex, Antigravity, and execution policy

| Method / route | Request | Response fields | Source |
|---|---|---|---|
| `GET /api/antigravity/status` | none | `{installed,authenticated,available,executable?,version?,model?:{id?,label?,effort?},quotaGroups?:[{name,description?,buckets:[{id?,name,window?,remainingFraction?,resetTime?]}],detail}` | `setup-server.ts:1196-1199`; producer types `antigravity-worker-provider.ts:55-82` |
| `GET /api/execution-policy` | none | `{settings,status,codex,accountBroker,authority}`. `codex` is `{installed,authenticated,version?,detail?}`. `settings` is execution settings. `status` fields below. | `setup-server.ts:1201-1212,203-246` |
| `POST /api/execution-policy` | Partial `{codexEnabled,antigravityEnabled,antigravityModel,defaultMode:'rwmcp-only'|'codex-only'|'both',allowChatOverride,codexFallback:'rwmcp-only'|'stop',maxCodexTasksPerSession,maxCodexTasksPerDay,codexAccountBroker:{enabled,mode:'native'|'cockpit-api-pool'}}` | Same shape as GET plus `restartRequired:boolean`, `authority:'owner-local-only'`. Enabling Antigravity or Cockpit pool verifies readiness first. | `setup-server.ts:1214-1286` |
| `POST /api/execution-policy/fallback-reset` | none | Same response shape, `restartRequired:false`. | `setup-server.ts:1289-1300` |
| `POST /api/execution-policy/clear-overrides` | none | Same response shape, `restartRequired:false`. | `setup-server.ts:1303-1314` |

`status` has `{configuredMode,effectiveMode,source,codexEnabled,allowChatOverride,codexFallback,fallbackActive,fallbackReason?,fallbackDetail?,fallbackActivatedAt?,workSessionId?,sessionOverride?,codexTasksToday,codexTasksThisSession,maxCodexTasksPerDay,maxCodexTasksPerSession,activeSessionOverrides,activeSessionFallbacks}` (`execution-policy.ts:194-220`). `accountBroker` has `{detected,brokerEnabled,requestedMode,effectiveBackend:'native'|'cockpit-api-pool'|'blocked',accounts,pool}`; pool includes `{configured,enabled,healthy,detail,port?,gatewayMode?,routingStrategy?,sessionAffinity?,coolingEnabled?,accountIds,apiKeyConfigured}` (`codex-account-broker.ts:41-48,268-287`).

## Devices, pairing, and multi-node

| Method / route | Request | Response fields | Source |
|---|---|---|---|
| `GET /api/devices/pairing` | none | `{devices, pending, bootstrapHosts}`. Device is public `{id,name,hostname,platform,arch?,version,capabilities,bootstrapTransport,bootstrapHostId?,credentialIssuedAt,pairedAt,lastSeenAt?,revokedAt?}`; no credential hash. Pending is `{id,createdAt,expiresAt,requestedName?,bootstrapHostId?}`. Host is `{id,name,hostname,platform:'ssh'}`. | `setup-server.ts:1157-1166`; types `pairing-store.ts:11-36,236-249` |
| `POST /api/devices/pairing-code` | `{requestedName?:string,bootstrapHostId?:string,ttlSeconds?:number}`; normalized to 60–3600 seconds. | `{pairingId,code,createdAt,expiresAt,requestedName?,bootstrapHostId?}`. The UI must treat `code` as transient sensitive material. | `setup-server.ts:1168-1176`; `pairing-store.ts:150-176` |
| `POST /api/devices/bootstrap-ssh` | `{hostId:string,code:string,name?:string}` | `{device,remoteConfigPath,credentialDelivered:true}`. Do not expose the remote credential in the UI. | `setup-server.ts:1179-1188`; `pairing-bootstrap.ts:88-129` |
| `POST /api/devices/:id/revoke` | none | Revoked public device object. `id` permits `[A-Za-z0-9._-]+`. | `setup-server.ts:1190-1195` |
| `GET /api/multi-node` | none | `{localNodeId,localNodeName,enabled,controllerPrincipalId,controllerPrincipalType,grants,requiredScope:'workstation.cross_node_transfer',scopeEnabled,configurationConsistent,policyPath}` | `setup-server.ts:1528-1531`; `multi-node.ts:106-130` |
| `POST /api/multi-node/enabled` | `{enabled:boolean}` | Multi-node state plus `restartRequired:true`. | `setup-server.ts:1533-1544`; `multi-node.ts:133-155` |
| `POST /api/multi-node/grants` | grant: `{id,enabled?,sourceNodeId,destinationNodeId,sourceWorkspace,destinationWorkspace,sourcePathPrefixes:string[],destinationBasePaths:string[],allowedExtensions:string[],maxBytes,transports:('direct'|'relay')[]}` | Multi-node state plus `restartRequired:true`. Paths are normalized relative; grant validation includes 512 MiB maximum. | `setup-server.ts:1546-1550`; schema `config.ts:8-20`; normalization `multi-node.ts:69-81` |
| `DELETE /api/multi-node/grants/:id` | none | Multi-node state plus `restartRequired:true`. ID max 96. | `setup-server.ts:1552-1557` |

## Access, updater, notifications, admin approval

| Method / route | Request | Response fields | Source |
|---|---|---|---|
| `GET /api/permissions` | none | `{mode,httpScopes,allowHostFilesystem,allowRawShell,policyPath,leasePath,lease?}`. Lease is `{mode,issuedAt,expiresAt,reason?,clientId?,active,remainingSeconds}`. | `setup-server.ts:1559-1562`; `permissions.ts:34-42,92-112` |
| `POST /api/permissions/mode` | `{mode:'read_only'|'workspace'|'full_control'}` | Permission state plus `restartRequired:true`. | `setup-server.ts:1564-1573` |
| `POST /api/permissions/config` | `{httpScopes:string[],allowHostFilesystem?:boolean,allowRawShell?:boolean}` | Permission state plus `restartRequired:true`. Supported scopes are read/write/execute/admin_request/full_control/cross_node_transfer. | `setup-server.ts:1575-1594`; `permissions.ts:15-22` |
| `POST /api/permissions/lease` | `{ttlMinutes:10|30|60}` | `{lease,restartRequired:true}`; only permitted after full-control scope and a local gate are enabled. | `setup-server.ts:1596-1608`; `permissions.ts:163-181` |
| `DELETE /api/permissions/lease` | none | `{ok:true,restartRequired:true}` | `setup-server.ts:1610-1614` |
| `GET /api/update/status` | none | Platform updater status. UI relies on `supported,enabled,installedVersion?,latestVersion?,updateAvailable,updateKind?,message?`; Linux also returns `mode,channel:'stable',automaticPolicy:'patch',automaticInstallAllowed`. Windows may add `transaction`. | `setup-server.ts:1317-1320`; Linux `:886-958`; Windows `:856-884` |
| `POST /api/update/check` | none | Same updater status shape. | `setup-server.ts:1322-1325` |
| `POST /api/update/config` | `{enabled:boolean}` | Same updater status shape. | `setup-server.ts:1327-1332` |
| `POST /api/update/install` | none | Updater result; `202` iff `{accepted:true}`, otherwise `200`. May include `alreadyRunning`, `transaction`. | `setup-server.ts:1334-1339` |
| `GET /api/admin/requests` | none | `{requests: AdminRequest[]}` (maximum 20): request includes `{id,state,createdAt,expiresAt,clientId,clientType,program,args,cwd?,reason,commandHash,approvedAt?,deniedAt?,startedAt?,result?}`. | `setup-server.ts:1341-1345`; `approval-store.ts:7-33` |
| `POST /api/admin/requests/:uuid/approve` | `{expectedCommandHash:string}` | Windows: `202 {requestId,state,uacPrompted:true}`. | `setup-server.ts:1347-1368` |
| `POST /api/admin/requests/:uuid/deny` | no body | The resulting AdminRequest. | `setup-server.ts:1347-1354` |

Notifications are client-composed, not a backend endpoint: legacy UI polls execution policy, update status, and admin requests, then derives Codex fallback/unavailable, update available, and pending-admin notices (`ui.ts:533-538`). It keeps read state in browser storage. Preserve this composition or add a new aggregated endpoint only with a backend change.

## Other retained server routes (avoid accidental regression)

The server also exposes owner-only quality-learning endpoints, even though the current legacy UI does not consume them: `GET/POST /api/quality/settings`, `GET /api/quality/knowledge`, `POST /api/quality/knowledge/draft`, `POST /api/quality/knowledge/:uuid/(shadow|promote|revalidate|revoke)`, `DELETE /api/quality/history`, `GET /api/quality/review`, and `POST /api/quality/review/:uuid/(approve|reject|revoke)` (`setup-server.ts:1370-1526`). Preserve them during frontend replacement.

## Missing telemetry and frontend consequences

- No WebSocket/SSE/push, event timestamps for status snapshots, polling interval contract, or API health/version endpoint. The legacy page performs its initial refreshes at `ui.ts:555` and polls only admin requests every two seconds; other status views refresh by user action or workflow completion.
- No aggregated control-center status/notification endpoint; notification assembly is UI logic.
- No tunnel identifier metadata, tunnel-client version/process/PID, last tunnel error, latency, or transport throughput endpoint.
- No host liveness, SSH reachability, last probe/error, device online/offline state, or per-node capability health; `bootstrapHosts` is configuration-only.
- No update progress/log endpoint; installer output is returned once and Windows update only exposes transaction data opportunistically.
- No runtime action-job status endpoint; Windows restart returns acceptance rather than completion.
- Existing runtime response includes local file paths (`root`, log paths); a redesigned UI should avoid displaying them unless deliberately needed.
