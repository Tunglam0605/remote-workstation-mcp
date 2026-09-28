import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../src/adapters/engineering/network-diagnostics.js';

test('network host validation accepts IP/DNS and rejects URLs/options', () => {
  assert.equal(__test.assertHost('127.0.0.1'), '127.0.0.1');
  assert.equal(__test.assertHost('::1'), '::1');
  assert.equal(__test.assertHost('robot.local'), 'robot.local');
  assert.throws(() => __test.assertHost('https://example.com'), /valid IPv4, IPv6, or DNS hostname/i);
  assert.throws(() => __test.assertHost('-c4'), /valid IPv4, IPv6, or DNS hostname/i);
  assert.throws(() => __test.assertHost('a b'), /valid IPv4, IPv6, or DNS hostname/i);
});

test('network port validation is explicit and bounded', () => {
  assert.equal(__test.assertPort(1), 1);
  assert.equal(__test.assertPort(65535), 65535);
  assert.throws(() => __test.assertPort(0), /1\.\.65535/);
  assert.throws(() => __test.assertPort(65536), /1\.\.65535/);
});

test('Linux route parser keeps bounded typed route evidence', () => {
  const rows = __test.parseLinuxRoutes(JSON.stringify([
    { dst: 'default', gateway: '192.168.1.1', dev: 'eth0', protocol: 'dhcp', prefsrc: '192.168.1.10', metric: 100 },
    { dst: '10.0.0.0/24', dev: 'eth1', scope: 'link', prefsrc: '10.0.0.2' }
  ]));
  assert.deepEqual(rows[0], {
    destination: 'default', gateway: '192.168.1.1', interface: 'eth0', protocol: 'dhcp',
    scope: undefined, source: '192.168.1.10', metric: 100, table: undefined
  });
  assert.equal(rows[1]?.interface, 'eth1');
});

test('Windows route parser accepts one object or array without command text', () => {
  const one = __test.parseWindowsRoutes(JSON.stringify({
    DestinationPrefix: '0.0.0.0/0', NextHop: '192.168.1.1', InterfaceIndex: 12, RouteMetric: 25,
    Protocol: 'NetMgmt', AddressFamily: 2, State: 'Alive'
  }));
  assert.equal(one.length, 1);
  assert.equal(one[0]?.gateway, '192.168.1.1');
  const local = __test.parseWindowsRoutes(JSON.stringify([{ DestinationPrefix: '192.168.1.0/24', NextHop: '0.0.0.0' }]));
  assert.equal(local[0]?.gateway, undefined);
});

test('ping parser normalizes Linux and Windows summaries', () => {
  const linux = __test.parsePing(
    '4 packets transmitted, 3 received, 25% packet loss, time 3000ms\nrtt min/avg/max/mdev = 1.000/2.500/4.000/0.500 ms',
    '', 0, 3100
  );
  assert.equal(linux.reachable, true);
  assert.equal(linux.received, 3);
  assert.equal(linux.packetLossPercent, 25);
  assert.equal(linux.averageRttMs, 2.5);

  const windows = __test.parsePing(
    'Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),\r\nApproximate round trip times in milli-seconds:\r\nMinimum = 1ms, Maximum = 3ms, Average = 2ms',
    '', 0, 2500
  );
  assert.equal(windows.reachable, true);
  assert.equal(windows.transmitted, 4);
  assert.equal(windows.averageRttMs, 2);
});
