import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCanopenFrame } from '../src/extensions/canopen/canopen-adapter.js';

function frame(id: number, data: string[]) {
  return {
    timestamp: 10.5,
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
}

test('CANopen heartbeat decodes node id and NMT state', () => {
  const decoded = decodeCanopenFrame(frame(0x705, ['05']));
  assert.equal(decoded?.kind, 'heartbeat');
  assert.equal(decoded && 'nodeId' in decoded ? decoded.nodeId : undefined, 5);
  assert.equal(decoded && 'stateName' in decoded ? decoded.stateName : undefined, 'operational');
});

test('CANopen boot-up heartbeat is distinguished from operational heartbeat', () => {
  const decoded = decodeCanopenFrame(frame(0x701, ['00']));
  assert.equal(decoded?.kind, 'heartbeat');
  assert.equal(decoded && 'stateName' in decoded ? decoded.stateName : undefined, 'boot-up');
});

test('CANopen EMCY decodes little-endian emergency code and error register', () => {
  const decoded = decodeCanopenFrame(frame(0x083, ['10', '23', '05', 'AA', 'BB', 'CC', 'DD', 'EE']));
  assert.equal(decoded?.kind, 'emcy');
  assert.equal(decoded && 'nodeId' in decoded ? decoded.nodeId : undefined, 3);
  assert.equal(decoded && 'errorCode' in decoded ? decoded.errorCode : undefined, 0x2310);
  assert.equal(decoded && 'errorRegister' in decoded ? decoded.errorRegister : undefined, 0x05);
  assert.equal(decoded && 'manufacturerDataHex' in decoded ? decoded.manufacturerDataHex : undefined, 'AABBCCDDEE');
});

test('CANopen SDO abort response exposes object address and abort code', () => {
  const decoded = decodeCanopenFrame(frame(0x582, ['80', '00', '20', '01', '00', '00', '02', '06']));
  assert.equal(decoded?.kind, 'sdo-response');
  assert.equal(decoded && 'nodeId' in decoded ? decoded.nodeId : undefined, 2);
  assert.deepEqual(decoded && 'object' in decoded ? decoded.object : undefined, {
    index: 0x2000,
    indexHex: '0x2000',
    subIndex: 1
  });
  assert.equal(decoded && 'abortCodeHex' in decoded ? decoded.abortCodeHex : undefined, '0x06020000');
});

test('CANopen NMT command decodes target node without transmitting anything', () => {
  const decoded = decodeCanopenFrame(frame(0x000, ['01', '07']));
  assert.equal(decoded?.kind, 'nmt');
  assert.equal(decoded && 'commandName' in decoded ? decoded.commandName : undefined, 'start');
  assert.equal(decoded && 'targetNodeId' in decoded ? decoded.targetNodeId : undefined, 7);
});

test('CANopen PDO classification uses standard CiA 301 default COB-ID ranges', () => {
  const tpdo = decodeCanopenFrame(frame(0x185, ['01', '02']));
  const rpdo = decodeCanopenFrame(frame(0x205, ['03', '04']));
  assert.equal(tpdo?.kind, 'tpdo1');
  assert.equal(tpdo && 'nodeId' in tpdo ? tpdo.nodeId : undefined, 5);
  assert.equal(rpdo?.kind, 'rpdo1');
  assert.equal(rpdo && 'nodeId' in rpdo ? rpdo.nodeId : undefined, 5);
});

test('extended, CAN FD, RTR and error frames are excluded from classic CANopen decoding', () => {
  assert.equal(decodeCanopenFrame({ ...frame(0x705, ['05']), extended: true }), undefined);
  assert.equal(decodeCanopenFrame({ ...frame(0x705, ['05']), fd: true }), undefined);
  assert.equal(decodeCanopenFrame({ ...frame(0x705, ['05']), rtr: true }), undefined);
  assert.equal(decodeCanopenFrame({ ...frame(0x705, ['05']), error: true }), undefined);
});


test('CANopen SYNC counter and TIME payload expose protocol semantics', () => {
  const sync = decodeCanopenFrame(frame(0x080, ['07']));
  assert.equal(sync?.kind, 'sync');
  assert.equal(sync && 'counter' in sync ? sync.counter : undefined, 7);
  assert.equal(sync && 'protocol' in sync ? sync.protocol.valid : undefined, true);

  const time = decodeCanopenFrame(frame(0x100, ['E8', '03', '00', '00', '01', '00']));
  assert.equal(time?.kind, 'time');
  assert.equal(time && 'millisecondsAfterMidnight' in time ? time.millisecondsAfterMidnight : undefined, 1000);
  assert.equal(time && 'daysSince1984' in time ? time.daysSince1984 : undefined, 1);
  assert.equal(time && 'utcIso' in time ? time.utcIso : undefined, '1984-01-02T00:00:01.000Z');
});

test('CANopen protocol diagnostics flag malformed DLC without discarding evidence', () => {
  const malformedSync = decodeCanopenFrame(frame(0x080, ['00']));
  assert.equal(malformedSync?.kind, 'sync');
  assert.equal(malformedSync && 'protocol' in malformedSync ? malformedSync.protocol.valid : undefined, false);

  const malformedSdo = decodeCanopenFrame(frame(0x601, ['40', '00', '20', '00', '00', '00', '00']));
  assert.equal(malformedSdo?.kind, 'sdo-request');
  assert.equal(malformedSdo && 'protocol' in malformedSdo ? malformedSdo.protocol.valid : undefined, false);
});

test('CANopen SDO commands and abort codes are named from CiA 301 semantics', () => {
  const upload = decodeCanopenFrame(frame(0x603, ['40', '00', '20', '01', '00', '00', '00', '00']));
  assert.equal(upload && 'commandName' in upload ? upload.commandName : undefined, 'upload-initiate-request');

  const abort = decodeCanopenFrame(frame(0x583, ['80', '00', '20', '01', '00', '00', '02', '06']));
  assert.equal(abort && 'abort' in abort ? abort.abort?.name : undefined, 'object-not-present');
});

test('CANopen EMCY exposes standard error-register flags and error class', () => {
  const decoded = decodeCanopenFrame(frame(0x083, ['10', '23', '15', 'AA', 'BB', 'CC', 'DD', 'EE']));
  assert.equal(decoded && 'codeClass' in decoded ? decoded.codeClass : undefined, 'current');
  assert.deepEqual(decoded && 'errorRegisterFlags' in decoded ? decoded.errorRegisterFlags : undefined, [
    'generic', 'voltage', 'communication'
  ]);
});
