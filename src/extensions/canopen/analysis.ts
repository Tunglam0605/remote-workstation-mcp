export type CanopenAnalysisFrame = {
  timestamp: number;
  kind: string;
  nodeId?: number;
  targetNodeId?: number;
  cobId?: number;
  cobIdHex?: string;
  state?: number;
  stateName?: string;
  commandName?: string;
  transfer?: string;
  phase?: string;
  expedited?: boolean;
  object?: { index: number; indexHex?: string; subIndex: number };
  abortCode?: number;
  abortCodeHex?: string;
  abort?: { code?: number; codeHex?: string; name?: string };
  protocol?: { valid?: boolean; issues?: string[] };
};

export type CanopenAnalysisOptions = {
  gapFactor?: number;
};

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentile(values: number[], percentileValue: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1));
  return sorted[index];
}

function intervalStatistics(timestamps: number[], gapFactor: number) {
  const sorted = timestamps.filter(Number.isFinite).sort((a, b) => a - b);
  const intervalsMs: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const interval = (sorted[i]! - sorted[i - 1]!) * 1000;
    if (interval >= 0 && Number.isFinite(interval)) intervalsMs.push(interval);
  }
  if (!intervalsMs.length) {
    return {
      samples: sorted.length,
      intervalCount: 0
    };
  }

  const ordered = [...intervalsMs].sort((a, b) => a - b);
  const mean = intervalsMs.reduce((sum, value) => sum + value, 0) / intervalsMs.length;
  const median = percentile(ordered, 0.5)!;
  const p95 = percentile(ordered, 0.95)!;
  const jitter = intervalsMs.map(value => Math.abs(value - median));
  const p95AbsoluteJitter = percentile(jitter, 0.95)!;
  const gapThreshold = median > 0 ? median * gapFactor : undefined;
  const gapsOverThreshold = gapThreshold === undefined ? 0 : intervalsMs.filter(value => value > gapThreshold).length;

  return {
    samples: sorted.length,
    intervalCount: intervalsMs.length,
    minIntervalMs: round(ordered[0]!),
    meanIntervalMs: round(mean),
    medianIntervalMs: round(median),
    p95IntervalMs: round(p95),
    maxIntervalMs: round(ordered.at(-1)!),
    p95AbsoluteJitterMs: round(p95AbsoluteJitter),
    gapFactor,
    ...(gapThreshold !== undefined ? { gapThresholdMs: round(gapThreshold) } : {}),
    gapsOverThreshold
  };
}

function objectKey(frame: CanopenAnalysisFrame): string | undefined {
  const object = frame.object;
  return object ? `${object.index}:${object.subIndex}` : undefined;
}

function sameObject(a: CanopenAnalysisFrame, b: CanopenAnalysisFrame): boolean {
  const left = objectKey(a);
  const right = objectKey(b);
  return left === undefined || right === undefined || left === right;
}

function isSdoInitiateRequest(frame: CanopenAnalysisFrame): boolean {
  return frame.kind === 'sdo-request' &&
    frame.phase === 'initiate' &&
    (frame.transfer === 'upload' || frame.transfer === 'download');
}

function isSdoInitiateResponse(frame: CanopenAnalysisFrame): boolean {
  return frame.kind === 'sdo-response' &&
    frame.phase === 'initiate' &&
    (frame.transfer === 'upload' || frame.transfer === 'download');
}

function correlateSdoInitiates(frames: CanopenAnalysisFrame[]) {
  const ordered = [...frames].filter(frame => Number.isFinite(frame.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  const pending = new Map<number, CanopenAnalysisFrame[]>();
  const exchanges: Array<Record<string, unknown>> = [];
  let unexpectedResponses = 0;

  const queue = (nodeId: number) => {
    const existing = pending.get(nodeId);
    if (existing) return existing;
    const created: CanopenAnalysisFrame[] = [];
    pending.set(nodeId, created);
    return created;
  };

  for (const frame of ordered) {
    const nodeId = frame.nodeId;
    if (!Number.isInteger(nodeId) || nodeId! < 1 || nodeId! > 127) continue;

    if (isSdoInitiateRequest(frame)) {
      queue(nodeId!).push(frame);
      continue;
    }

    const abort = frame.kind === 'sdo-response' && frame.commandName === 'abort';
    if (!isSdoInitiateResponse(frame) && !abort) continue;

    const candidates = queue(nodeId!);
    let matchIndex = candidates.findIndex(candidate =>
      sameObject(candidate, frame) &&
      (abort || candidate.transfer === frame.transfer)
    );
    if (matchIndex < 0 && abort) matchIndex = candidates.findIndex(candidate => sameObject(candidate, frame));
    if (matchIndex < 0) {
      unexpectedResponses += 1;
      continue;
    }

    const request = candidates.splice(matchIndex, 1)[0]!;
    const latencyMs = Math.max(0, (frame.timestamp - request.timestamp) * 1000);
    const completedExpedited = !abort && (
      request.transfer === 'download' ? request.expedited === true : frame.expedited === true
    );
    exchanges.push({
      nodeId,
      transfer: request.transfer,
      ...(request.object ? { object: request.object } : {}),
      requestTimestamp: request.timestamp,
      responseTimestamp: frame.timestamp,
      latencyMs: round(latencyMs),
      requestCommand: request.commandName,
      responseCommand: frame.commandName,
      outcome: abort ? 'aborted' : completedExpedited ? 'completed-expedited' : 'initiate-acknowledged',
      ...(frame.abortCodeHex ? { abortCodeHex: frame.abortCodeHex } : {}),
      ...(frame.abort?.name ? { abortName: frame.abort.name } : {})
    });
  }

  const pendingRequests = [...pending.entries()].flatMap(([nodeId, requests]) =>
    requests.map(request => ({
      nodeId,
      transfer: request.transfer,
      ...(request.object ? { object: request.object } : {}),
      requestTimestamp: request.timestamp,
      requestCommand: request.commandName,
      outcome: 'pending-initiate-response'
    }))
  );

  const completedLatencies = exchanges
    .map(exchange => typeof exchange.latencyMs === 'number' ? exchange.latencyMs : undefined)
    .filter((value): value is number => value !== undefined);
  const abortedCount = exchanges.filter(exchange => exchange.outcome === 'aborted').length;

  return {
    initiateRequestCount: ordered.filter(isSdoInitiateRequest).length,
    matchedExchangeCount: exchanges.length,
    completedExpeditedCount: exchanges.filter(exchange => exchange.outcome === 'completed-expedited').length,
    initiateAcknowledgedCount: exchanges.filter(exchange => exchange.outcome === 'initiate-acknowledged').length,
    abortedCount,
    pendingRequestCount: pendingRequests.length,
    unexpectedResponseCount: unexpectedResponses,
    ...(completedLatencies.length ? {
      latencyMs: {
        min: round(Math.min(...completedLatencies)),
        mean: round(completedLatencies.reduce((sum, value) => sum + value, 0) / completedLatencies.length),
        p95: round(percentile(completedLatencies, 0.95)!),
        max: round(Math.max(...completedLatencies))
      }
    } : {}),
    exchanges: exchanges.slice(0, 128),
    pendingRequests: pendingRequests.slice(0, 64)
  };
}

function timingGroups(frames: CanopenAnalysisFrame[], gapFactor: number) {
  const groups = new Map<string, { kind: string; nodeId?: number; timestamps: number[] }>();

  for (const frame of frames) {
    const periodic = frame.kind === 'heartbeat' || frame.kind === 'sync' || /^(?:tpdo|rpdo)[1-4]$/.test(frame.kind);
    if (!periodic || !Number.isFinite(frame.timestamp)) continue;
    if (frame.kind !== 'sync' && (!Number.isInteger(frame.nodeId) || frame.nodeId! < 1 || frame.nodeId! > 127)) continue;
    const key = frame.kind === 'sync' ? 'sync' : `${frame.kind}:${frame.nodeId}`;
    const existing = groups.get(key);
    if (existing) existing.timestamps.push(frame.timestamp);
    else groups.set(key, { kind: frame.kind, ...(frame.kind === 'sync' ? {} : { nodeId: frame.nodeId }), timestamps: [frame.timestamp] });
  }

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      kind: group.kind,
      ...(group.nodeId !== undefined ? { nodeId: group.nodeId } : {}),
      ...intervalStatistics(group.timestamps, gapFactor)
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, 256);
}

function nodeInventory(frames: CanopenAnalysisFrame[], gapFactor: number) {
  const nodeIds = new Set<number>();
  for (const frame of frames) {
    if (Number.isInteger(frame.nodeId) && frame.nodeId! >= 1 && frame.nodeId! <= 127) nodeIds.add(frame.nodeId!);
    if (frame.kind === 'nmt' && Number.isInteger(frame.targetNodeId) && frame.targetNodeId! >= 1 && frame.targetNodeId! <= 127) {
      nodeIds.add(frame.targetNodeId!);
    }
  }

  return [...nodeIds].sort((a, b) => a - b).map(nodeId => {
    const direct = frames.filter(frame => frame.nodeId === nodeId);
    const nmt = frames.filter(frame => frame.kind === 'nmt' && (frame.targetNodeId === 0 || frame.targetNodeId === nodeId));
    const heartbeats = direct.filter(frame => frame.kind === 'heartbeat').sort((a, b) => a.timestamp - b.timestamp);
    const emcy = direct.filter(frame => frame.kind === 'emcy').sort((a, b) => a.timestamp - b.timestamp);
    const states = heartbeats.filter(frame => typeof frame.stateName === 'string');
    const stateTransitions: Array<{ timestamp: number; from: string; to: string }> = [];
    for (let i = 1; i < states.length; i += 1) {
      const previous = states[i - 1]!;
      const current = states[i]!;
      if (previous.stateName !== current.stateName) {
        stateTransitions.push({ timestamp: current.timestamp, from: previous.stateName!, to: current.stateName! });
      }
    }
    const timestamps = direct.map(frame => frame.timestamp).filter(Number.isFinite).sort((a, b) => a - b);
    const protocolIssues = direct.reduce((sum, frame) => sum + (frame.protocol?.issues?.length ?? 0), 0);

    return {
      nodeId,
      observedFrameCount: direct.length,
      firstSeenTimestamp: timestamps[0],
      lastSeenTimestamp: timestamps.at(-1),
      heartbeat: {
        count: heartbeats.length,
        bootUpCount: heartbeats.filter(frame => frame.state === 0).length,
        ...(states.length ? {
          lastState: states.at(-1)!.stateName,
          lastTimestamp: states.at(-1)!.timestamp
        } : {}),
        cadence: intervalStatistics(heartbeats.map(frame => frame.timestamp), gapFactor),
        stateTransitions: stateTransitions.slice(0, 64)
      },
      nmtCommandCount: nmt.length,
      emcyCount: emcy.length,
      latestEmcy: emcy.at(-1),
      sdoRequestCount: direct.filter(frame => frame.kind === 'sdo-request').length,
      sdoResponseCount: direct.filter(frame => frame.kind === 'sdo-response').length,
      pdo: {
        tpdo1: direct.filter(frame => frame.kind === 'tpdo1').length,
        tpdo2: direct.filter(frame => frame.kind === 'tpdo2').length,
        tpdo3: direct.filter(frame => frame.kind === 'tpdo3').length,
        tpdo4: direct.filter(frame => frame.kind === 'tpdo4').length,
        rpdo1: direct.filter(frame => frame.kind === 'rpdo1').length,
        rpdo2: direct.filter(frame => frame.kind === 'rpdo2').length,
        rpdo3: direct.filter(frame => frame.kind === 'rpdo3').length,
        rpdo4: direct.filter(frame => frame.kind === 'rpdo4').length
      },
      protocolIssueCount: protocolIssues
    };
  });
}

export function analyzeCanopenFrames(frames: CanopenAnalysisFrame[], options: CanopenAnalysisOptions = {}) {
  const gapFactor = options.gapFactor ?? 2;
  if (!Number.isFinite(gapFactor) || gapFactor < 1.1 || gapFactor > 10) {
    throw new Error('CANopen analysis gapFactor must be between 1.1 and 10.');
  }
  if (frames.length > 1000) throw new Error('CANopen analysis accepts at most 1000 decoded frames.');

  const bounded = frames.slice(0, 1000);
  const kinds: Record<string, number> = {};
  let protocolIssueFrameCount = 0;
  const protocolIssueExamples: Array<Record<string, unknown>> = [];

  for (const frame of bounded) {
    kinds[frame.kind] = (kinds[frame.kind] ?? 0) + 1;
    const issues = frame.protocol?.issues ?? [];
    if (issues.length) {
      protocolIssueFrameCount += 1;
      if (protocolIssueExamples.length < 32) {
        protocolIssueExamples.push({
          timestamp: frame.timestamp,
          kind: frame.kind,
          ...(frame.nodeId !== undefined ? { nodeId: frame.nodeId } : {}),
          ...(frame.cobIdHex ? { cobIdHex: frame.cobIdHex } : {}),
          issues: issues.slice(0, 8)
        });
      }
    }
  }

  const nodes = nodeInventory(bounded, gapFactor);

  return {
    frameCount: bounded.length,
    kinds,
    nodeCount: nodes.length,
    nodes,
    sdo: correlateSdoInitiates(bounded),
    timing: {
      interpretation: 'Evidence-only cadence statistics. Gaps are relative to the observed median and are not declared protocol timeouts without an explicit configured timeout.',
      groups: timingGroups(bounded, gapFactor)
    },
    protocol: {
      issueFrameCount: protocolIssueFrameCount,
      issueExamples: protocolIssueExamples
    }
  };
}
