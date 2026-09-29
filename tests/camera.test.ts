import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CameraProfileStore } from '../src/extensions/camera/profile-store.js';
import { parseSdp, probeRtsp } from '../src/extensions/camera/rtsp-client.js';

test('camera profile store loads bounded anonymous RTSP profiles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-camera-'));
  const file = path.join(root, 'camera-profiles.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    profiles: [{
      id: 'warehouse-1',
      label: 'Warehouse camera 1',
      host: '192.168.1.20',
      port: 554,
      path: '/Streaming/Channels/101',
      transport: 'tcp',
      auth: 'none'
    }]
  }));
  const store = new CameraProfileStore(file);
  const profiles = await store.list();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.id, 'warehouse-1');
  assert.equal(profiles[0]?.path, '/Streaming/Channels/101');
  assert.deepEqual(await store.status(), { configured: true, profileCount: 1 });
  await fs.rm(root, { recursive: true, force: true });
});

test('camera profile store rejects URL userinfo, query tokens and traversal-like paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-camera-'));
  const file = path.join(root, 'camera-profiles.json');
  const store = new CameraProfileStore(file);

  await fs.writeFile(file, JSON.stringify({
    version: 1,
    profiles: [{ id: 'bad-host', host: 'user@camera.local', path: '/live' }]
  }));
  await assert.rejects(() => store.list(), /hostname or IP address|invalid/i);

  await fs.writeFile(file, JSON.stringify({
    version: 1,
    profiles: [{ id: 'bad-query', host: 'camera.local', path: '/live?key=value' }]
  }));
  await assert.rejects(() => store.list(), /query|fragment|userinfo/i);

  await fs.writeFile(file, JSON.stringify({
    version: 1,
    profiles: [{ id: 'bad-path', host: 'camera.local', path: '/../admin' }]
  }));
  await assert.rejects(() => store.list(), /traversal/i);

  await fs.rm(root, { recursive: true, force: true });
});

test('SDP parser extracts bounded media tracks, payload ids and codecs', () => {
  const tracks = parseSdp([
    'v=0',
    'm=video 0 RTP/AVP 96',
    'a=rtpmap:96 H264/90000',
    'a=control:trackID=1',
    'm=audio 0 RTP/AVP 97',
    'a=rtpmap:97 MPEG4-GENERIC/48000/2',
    'a=control:trackID=2',
    ''
  ].join('\r\n'));
  assert.deepEqual(tracks, [
    { media: 'video', payloadTypes: [96], codecs: ['H264'], control: 'trackID=1' },
    { media: 'audio', payloadTypes: [97], codecs: ['MPEG4-GENERIC'], control: 'trackID=2' }
  ]);
});

test('RTSP probe performs one bounded DESCRIBE and reports SDP evidence', async () => {
  let request = '';
  const server = net.createServer(socket => {
    socket.on('data', chunk => {
      request += chunk.toString('utf8');
      const body = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H265/90000\r\na=control:track1\r\n';
      socket.end([
        'RTSP/1.0 200 OK',
        'CSeq: 1',
        'Server: test-camera',
        'Content-Type: application/sdp',
        'Content-Length: ' + Buffer.byteLength(body),
        '',
        body
      ].join('\r\n'));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const result = await probeRtsp({
      id: 'cam',
      host: '127.0.0.1',
      port: address.port,
      path: '/live',
      transport: 'tcp',
      auth: 'none'
    }, 2_000);
    assert.equal(result.statusCode, 200);
    assert.equal(result.authRequired, false);
    assert.equal(result.tracks[0]?.codecs[0], 'H265');
    assert.match(request, /^DESCRIBE rtsp:\/\/127\.0\.0\.1:/);
    assert.doesNotMatch(request, /Authorization:/i);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('RTSP probe reports authentication requirement without credential exchange', async () => {
  const server = net.createServer(socket => {
    socket.once('data', () => {
      socket.end([
        'RTSP/1.0 401 Unauthorized',
        'CSeq: 1',
        'WWW-Authenticate: Digest realm="camera", nonce="fixture"',
        'Content-Length: 0',
        '',
        ''
      ].join('\r\n'));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const result = await probeRtsp({
      id: 'cam',
      host: '127.0.0.1',
      port: address.port,
      path: '/live',
      transport: 'tcp',
      auth: 'none'
    }, 2_000);
    assert.equal(result.statusCode, 401);
    assert.equal(result.authRequired, true);
    assert.deepEqual(result.authSchemes, ['digest']);
    assert.deepEqual(result.tracks, []);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
