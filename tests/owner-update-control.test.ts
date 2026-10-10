import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { OwnerUpdateControl, verifyOfficialDevelopmentTag, verifyManagedSlotPath } from '../src/adapters/owner-update-control.js';
import { resolveWindowsManagedRestartRoot } from '../src/setup/windows-managed-restart-root.js';
import { requiredScopeForTool, assertToolScope, runAsPrincipal } from '../src/security/request-principal.js';

const token = 'A'.repeat(43);
const csrfPage = '<html><meta name="rwmcp-setup-token" content="' + token + '"></html>';
const granted = { assertFullControl: () => {} };
const denied = { assertFullControl: () => { throw new Error('Full Control is required'); } };

test('owner update rejects arbitrary commands, URLs and unsigned latest aliases', async () => {
  let calls = 0;
  const transport = async () => { calls++; return new Response(csrfPage); };
  const adapter = new OwnerUpdateControl(granted, 8684, transport, 'win32', 'C:\\Users\\Test\\AppData\\Local');
  for (const value of ['latest', 'v0.70.0', 'https://example.com', 'v0.70.0-dev.7;Stop-Process', 'v0.70.0-dev.7\\n']) {
    assert.throws(() => verifyOfficialDevelopmentTag(value), /exact vX\.Y\.Z-dev\.N/);
    await assert.rejects(adapter.install(value), /exact vX\.Y\.Z-dev\.N/);
  }
  assert.equal(calls, 0, 'Rejected versions must never contact local Control Center');
});

test('owner Full Control lease is required before any network call', async () => {
  let calls = 0;
  const adapter = new OwnerUpdateControl(denied, 8684, async () => { calls++; return new Response(csrfPage); }, 'win32', 'C:\\Users\\Test\\AppData\\Local');
  await assert.rejects(adapter.install('v0.70.0-dev.7'), /Full Control/);
  await assert.rejects(adapter.restart('v0.70.0-dev.7'), /Full Control/);
  await assert.rejects(adapter.status(), /Full Control/);
  assert.equal(calls, 0);
});

test('exact prerelease update uses only CSRF-protected persistent owner Control Center', async () => {
  const requests: Array<{ url: string; method: string; body?: string; headers?: HeadersInit }> = [];
  const transport = async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method ?? '', body: init.body as string | undefined, headers: init.headers });
    if (init.method === 'GET') return new Response(csrfPage, { status: 200 });
    return new Response(JSON.stringify({ accepted: true, transaction: { state: 'RUNNING', requestedVersion: 'v0.70.0-dev.7' } }), { status: 202 });
  };
  const adapter = new OwnerUpdateControl(granted, 8684, transport, 'win32', 'C:\\Users\\Test\\AppData\\Local');
  const outcome = await adapter.install('v0.70.0-dev.7');
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.state, 'RUNNING');
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, 'http://127.0.0.1:8684/');
  assert.equal(requests[1]?.url, 'http://127.0.0.1:8684/api/update/install');
  assert.deepEqual(JSON.parse(requests[1]?.body ?? ''), { version: 'v0.70.0-dev.7' });
  const headers = requests[1]!.headers as Record<string,string>;
  assert.equal(headers['x-rwmcp-setup-token'], token);
  assert.equal(headers.Origin, 'http://127.0.0.1:8684');
  assert.equal(JSON.stringify(outcome).includes(token), false, 'Never expose CSRF token in tool result');
});

test('managed restart root follows verified current version slot instead of stale Control Center root', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-owner-slot-'));
  t.after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });
  const base = path.join(tmp, 'RemoteWorkstationMCP');
  const oldRoot = path.join(base, 'versions', 'v0.70.0-dev.6');
  const newRoot = path.join(base, 'versions', 'v0.70.0-dev.7');
  for (const [dir,version] of [[oldRoot,'0.70.0-dev.6'],[newRoot,'0.70.0-dev.7']]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir,'package.json'), JSON.stringify({ version }));
  }
  await fs.writeFile(path.join(base, 'current.txt'), '\uFEFF' + newRoot + '\n');
  assert.equal(await resolveWindowsManagedRestartRoot(oldRoot, base), newRoot);
  assert.equal(await resolveWindowsManagedRestartRoot(path.join(tmp,'source-checkout'), base), path.join(tmp,'source-checkout'));
  await fs.writeFile(path.join(base,'current.txt'), path.join(tmp,'outside'));
  await assert.rejects(resolveWindowsManagedRestartRoot(oldRoot,base), /verified version directory/);
  await fs.writeFile(path.join(base,'current.txt'), newRoot);
  await fs.writeFile(path.join(newRoot,'package.json'), JSON.stringify({version:'0.70.0-dev.99'}));
  await assert.rejects(resolveWindowsManagedRestartRoot(oldRoot,base), /package version disagrees/);
});

test('restart refuses mismatched/currently-updating slot and issues typed handoff when accepted', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-owner-update-'));
  t.after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });
  const base = path.join(tmp, 'RemoteWorkstationMCP');
  const slot = path.join(base, 'versions', 'v0.70.0-dev.7');
  await fs.mkdir(path.join(base,'runtime'), {recursive:true});
  await fs.writeFile(path.join(base,'current.txt'),slot);
  const requests: string[]=[];
  const transport = async (url:string,init:RequestInit)=>{
    requests.push(url);
    return init.method==='GET' ? new Response(csrfPage) :
      new Response(JSON.stringify({accepted:true,transaction:{state:'RUNNING'}}),{status:202});
  };
  const adapter = new OwnerUpdateControl(granted,8684,transport,'win32',tmp);
  await assert.rejects(adapter.restart('v0.70.0-dev.8'),/does not match exact requested/);
  assert.equal(requests.length,0);
  await fs.writeFile(path.join(base,'runtime','update-transaction.json'),JSON.stringify({state:'RUNNING'}));
  await assert.rejects(adapter.restart('v0.70.0-dev.7'),/still active/);
  assert.equal(requests.length,0);
  await fs.writeFile(path.join(base,'runtime','update-transaction.json'),JSON.stringify({state:'SUCCEEDED'}));
  const result=await adapter.restart('v0.70.0-dev.7');
  assert.equal(result.accepted,true);
  assert.deepEqual(requests,['http://127.0.0.1:8684/','http://127.0.0.1:8684/api/runtime/action']);
});

test('managed slot path rejects traversal and arbitrary local paths', () => {
  const base=path.join(os.tmpdir(),'rwmcp-root');
  assert.equal(verifyManagedSlotPath(base,path.join(base,'versions','v0.70.0-dev.7')).version,'0.70.0-dev.7');
  assert.throws(()=>verifyManagedSlotPath(base,path.join(base,'..','outside')),/verified version directory/);
  assert.throws(()=>verifyManagedSlotPath(base,path.join(base,'versions','v0.70.0-dev.7','subdir')),/verified version directory/);
});

test('new owner update MCP actions require full_control authenticated scope', () => {
  for(const name of ['update_install','update_install_status','update_restart']) {
    assert.equal(requiredScopeForTool(name), 'workstation.full_control');
    assert.throws(
      () => runAsPrincipal({ id:'read-user', type:'test', authenticated:true, scopes:['workstation.read'] }, () => assertToolScope(name)),
      /lacks required scope/
    );
    assert.doesNotThrow(
      () => runAsPrincipal({ id:'owner', type:'test', authenticated:true, scopes:['workstation.full_control'] }, () => assertToolScope(name))
    );
  }
});

test('legacy PowerShell safe-restart script parses current CSRF meta rather than removed inline token', async () => {
  const script = await fs.readFile(new URL('../scripts/safe-restart-windows.ps1',import.meta.url),'utf8');
  assert.match(script,/rwmcp-setup-token/);
  assert.match(script,/api\/runtime\/action/);
  assert.doesNotMatch(script,/\[regex\]::Match\(\[string\]\$page\.Content, 'const token/);
});
