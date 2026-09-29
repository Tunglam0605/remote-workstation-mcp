import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CameraProfileStore } from '../src/extensions/camera/profile-store.js';
import { parseSdp, probeRtsp } from '../src/extensions/camera/rtsp-client.js';
import { OnvifPtzClient } from '../src/extensions/camera/onvif-ptz.js';

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
  assert.deepEqual(await store.status(), { configured: true, profileCount: 1, ptzProfileCount: 0, ptzCredentialReadyCount: 0 });
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


test('camera PTZ profile redacts credential references from public output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-camera-'));
  const file = path.join(root, 'camera-profiles.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    profiles: [{
      id: 'ptz-1',
      host: '127.0.0.1',
      path: '/live',
      ptz: {
        scheme: 'http',
        port: 80,
        path: '/onvif/ptz_service',
        profileToken: 'Profile_1',
        username: 'operator',
        passwordEnv: 'RWMCP_CAMERA_PTZ_TEST_PASSWORD'
      }
    }]
  }));
  const store = new CameraProfileStore(file, { RWMCP_CAMERA_PTZ_TEST_PASSWORD: 'fixture-password-value' });
  const profile = await store.get('ptz-1');
  const publicProfile = store.toPublicProfile(profile);
  assert.equal(publicProfile.ptzConfigured, true);
  assert.equal(publicProfile.ptzCredentialReady, true);
  assert.doesNotMatch(JSON.stringify(publicProfile), /fixture-password-value|RWMCP_CAMERA_PTZ_TEST_PASSWORD|operator/);
  const resolved = await store.resolvePtz('ptz-1');
  assert.equal(resolved.ptz.password, 'fixture-password-value');
  await fs.rm(root, { recursive: true, force: true });
});

test('ONVIF PTZ bounded move uses password digest and always follows with Stop', async () => {
  const actions: string[] = [];
  const bodies: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    bodies.push(body);
    const action = String(req.headers['content-type'] ?? '');
    actions.push(action);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/soap+xml; charset=utf-8');
    res.end('<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body/></s:Envelope>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const client = new OnvifPtzClient();
    const result = await client.move({
      id: 'ptz-1',
      host: '127.0.0.1',
      port: 554,
      path: '/live',
      transport: 'tcp',
      auth: 'none',
      ptz: {
        scheme: 'http',
        port: address.port,
        path: '/onvif/ptz_service',
        profileToken: 'Profile_1',
        username: 'operator',
        passwordEnv: 'UNUSED_IN_RESOLVED_FIXTURE',
        password: 'fixture-password-value'
      }
    }, { pan: 0.5, tilt: -0.25, zoom: 0.1 }, 50, 2_000);

    assert.equal(result.autoStopped, true);
    assert.equal(actions.length, 2);
    assert.match(actions[0] ?? '', /ContinuousMove/);
    assert.match(actions[1] ?? '', /Stop/);
    assert.match(bodies[0] ?? '', /PasswordDigest/);
    assert.match(bodies[0] ?? '', /<wsse:Nonce/);
    assert.match(bodies[0] ?? '', /<wsu:Created>/);
    assert.match(bodies[0] ?? '', /<tt:PanTilt x="0\.5" y="-0\.25"\/>/);
    assert.match(bodies[0] ?? '', /<tt:Zoom x="0\.1"\/>/);
    assert.doesNotMatch(bodies[0] ?? '', /fixture-password-value/);
    assert.match(bodies[1] ?? '', /<tptz:Stop>/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('ONVIF PTZ status parses bounded position and move-state evidence', async () => {
  const server = http.createServer(async (_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/soap+xml; charset=utf-8');
    res.end([
      '<?xml version="1.0"?>',
      '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">',
      '<s:Body><tptz:GetStatusResponse><tptz:PTZStatus>',
      '<tt:Position><tt:PanTilt x="0.2" y="-0.4"/><tt:Zoom x="0.7"/></tt:Position>',
      '<tt:MoveStatus><tt:PanTilt>IDLE</tt:PanTilt><tt:Zoom>MOVING</tt:Zoom></tt:MoveStatus>',
      '</tptz:PTZStatus></tptz:GetStatusResponse></s:Body></s:Envelope>'
    ].join(''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const client = new OnvifPtzClient();
    const status = await client.status({
      id: 'ptz-1',
      host: '127.0.0.1',
      port: 554,
      path: '/live',
      transport: 'tcp',
      auth: 'none',
      ptz: {
        scheme: 'http',
        port: address.port,
        path: '/onvif/ptz_service',
        profileToken: 'Profile_1',
        username: 'operator',
        passwordEnv: 'UNUSED_IN_RESOLVED_FIXTURE',
        password: 'fixture-password-value'
      }
    }, 2_000);
    assert.deepEqual(status.position, { pan: 0.2, tilt: -0.4, zoom: 0.7 });
    assert.deepEqual(status.moveStatus, { panTilt: 'IDLE', zoom: 'MOVING' });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
