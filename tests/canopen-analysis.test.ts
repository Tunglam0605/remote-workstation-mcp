import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeCanopenFrames, type CanopenAnalysisFrame } from '../src/extensions/canopen/analysis.js';
import { decodeCanopenFrame } from '../src/extensions/canopen/canopen-adapter.js';

function decoded(timestamp: number, id: number, data: string[]): CanopenAnalysisFrame {
  const raw = {
    timestamp,
    interface: 'can0',
    id,
    idHex: id.toString(16).toUpperCase().padStart(3, '0'),
    extended: false,
    fd: false,
    rtr: false,
    error: false,
    dlc: data.length,
    dataHex: data.join(''),
    data
  };
  const value = decodeCanopenFrame(raw);
  assert.ok(value);
  return value;
}

test('generic CANopen analysis builds node inventory, state transitions and evidence-only timing', () => {
  const frames = [
    decoded(1.0, 0x705, ['00']),
    decoded(1.1, 0x705, ['05']),
    decoded(1.2, 0x185, ['11', '22']),
    decoded(1.2, 0x705, ['05']),
    decoded(1.5, 0x705, ['7F']),
    decoded(1.6, 0x085, ['10', '23', '01', '00', '00', '00', '00', '00'])
  ];
  const analysis = analyzeCanopenFrames(frames, { gapFactor: 2 });
  assert.equal(analysis.nodeCount, 1);
  const node = analysis.nodes[0]!;
  assert.equal(node.nodeId, 5);
  assert.equal(node.heartbeat.count, 4);
  assert.equal(node.heartbeat.bootUpCount, 1);
  assert.equal(node.heartbeat.lastState, 'pre-operational');
  assert.deepEqual(node.heartbeat.stateTransitions.map(item => [item.from, item.to]), [
    ['boot-up', 'operational'],
    ['operational', 'pre-operational']
  ]);
  assert.equal(node.pdo.tpdo1, 1);
  assert.equal(node.emcyCount, 1);
  assert.equal(node.heartbeat.cadence.medianIntervalMs, 100);
  assert.equal(node.heartbeat.cadence.gapsOverThreshold, 1);
  assert.match(analysis.timing.interpretation, /not declared protocol timeouts/i);
});

test('generic CANopen analysis correlates SDO initiate exchanges without overclaiming segmented completion', () => {
  const frames = [
    decoded(2.000, 0x605, ['40', '00', '20', '00', '00', '00', '00', '00']),
    decoded(2.012, 0x585, ['4B', '00', '20', '00', '34', '12', '00', '00']),
    decoded(3.000, 0x605, ['21', '01', '20', '00', '08', '00', '00', '00']),
    decoded(3.020, 0x585, ['60', '01', '20', '00', '00', '00', '00', '00']),
    decoded(4.000, 0x605, ['40', '02', '20', '00', '00', '00', '00', '00']),
    decoded(4.008, 0x585, ['80', '02', '20', '00', '00', '00', '02', '06']),
    decoded(5.000, 0x605, ['40', '03', '20', '00', '00', '00', '00', '00'])
  ];
  const analysis = analyzeCanopenFrames(frames);
  assert.equal(analysis.sdo.initiateRequestCount, 4);
  assert.equal(analysis.sdo.matchedExchangeCount, 3);
  assert.equal(analysis.sdo.completedExpeditedCount, 1);
  assert.equal(analysis.sdo.initiateAcknowledgedCount, 1);
  assert.equal(analysis.sdo.abortedCount, 1);
  assert.equal(analysis.sdo.pendingRequestCount, 1);
  assert.equal(analysis.sdo.unexpectedResponseCount, 0);
  assert.equal(analysis.sdo.exchanges[0]?.outcome, 'completed-expedited');
  assert.equal(analysis.sdo.exchanges[1]?.outcome, 'initiate-acknowledged');
  assert.equal(analysis.sdo.exchanges[2]?.abortName, 'object-not-present');
  assert.equal(analysis.sdo.latencyMs?.max, 20);
});

test('generic CANopen analysis groups PDO, Heartbeat and SYNC cadence independently', () => {
  const frames = [
    decoded(1.00, 0x080, []),
    decoded(1.01, 0x185, ['01']),
    decoded(1.02, 0x705, ['05']),
    decoded(1.10, 0x080, []),
    decoded(1.11, 0x185, ['02']),
    decoded(1.12, 0x705, ['05']),
    decoded(1.20, 0x080, []),
    decoded(1.21, 0x185, ['03']),
    decoded(1.22, 0x705, ['05'])
  ];
  const analysis = analyzeCanopenFrames(frames);
  const groups = new Map(analysis.timing.groups.map(group => [group.key, group]));
  assert.equal(groups.get('sync')?.medianIntervalMs, 100);
  assert.equal(groups.get('tpdo1:5')?.medianIntervalMs, 100);
  assert.equal(groups.get('heartbeat:5')?.medianIntervalMs, 100);
});

test('generic CANopen analysis surfaces protocol issues but keeps bounded evidence', () => {
  const malformed = decoded(1, 0x605, ['40', '00', '20', '00', '00', '00', '00']);
  const analysis = analyzeCanopenFrames([malformed]);
  assert.equal(analysis.protocol.issueFrameCount, 1);
  assert.equal(analysis.protocol.issueExamples.length, 1);
  assert.match(String(analysis.protocol.issueExamples[0]?.issues), /Expected DLC 8/);
});

test('default SDO client abort frame exposes abort semantics for passive analysis', () => {
  const abort = decoded(1, 0x605, ['80', '00', '20', '00', '00', '00', '02', '06']);
  assert.equal(abort.commandName, 'abort');
  assert.equal(abort.abortCodeHex, '0x06020000');
  assert.equal(abort.abort?.name, 'object-not-present');
});

test('analysis bounds inputs and gap-factor assumptions', () => {
  assert.throws(() => analyzeCanopenFrames([], { gapFactor: 1 }), /gapFactor/i);
  assert.throws(() => analyzeCanopenFrames(Array.from({ length: 1001 }, (_, index) => ({
    timestamp: index,
    kind: 'sync'
  }))), /at most 1000/i);
});
