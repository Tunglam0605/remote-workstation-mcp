export function setupHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Remote Workstation MCP Setup</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827;background:#f3f4f6}*{box-sizing:border-box}body{margin:0}.wrap{max-width:980px;margin:32px auto;padding:0 18px}.hero{background:#111827;color:white;border-radius:18px;padding:24px 26px;margin-bottom:18px}.hero h1{margin:0 0 8px;font-size:28px}.hero p{margin:0;color:#d1d5db;line-height:1.5}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.card{background:white;border:1px solid #e5e7eb;border-radius:16px;padding:20px;box-shadow:0 4px 16px rgba(0,0,0,.04)}.card h2{margin:0 0 14px;font-size:18px}.full{grid-column:1/-1}label{display:block;font-size:13px;font-weight:650;margin:12px 0 6px}input,select{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:10px;font:inherit;background:white}button,.btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:10px;padding:10px 14px;font:inherit;font-weight:650;cursor:pointer;text-decoration:none}.primary{background:#111827;color:white}.secondary{background:#e5e7eb;color:#111827}.ok{color:#067647}.warn{color:#b54708}.bad{color:#b42318}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.status{font-size:13px;line-height:1.65}.muted{color:#6b7280;font-size:13px;line-height:1.5}.pill{display:inline-block;padding:4px 8px;border-radius:999px;background:#eef2ff;font-size:12px;margin:2px 4px 2px 0}.notice{padding:12px 14px;border-radius:10px;background:#fffbeb;border:1px solid #fde68a;font-size:13px;line-height:1.5}.secret-note{font-size:12px;color:#6b7280;margin-top:5px}.log{white-space:pre-wrap;background:#0b1020;color:#d1fae5;border-radius:10px;padding:12px;max-height:260px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.footer{margin:18px 0 30px;color:#6b7280;font-size:12px}.check{display:flex;gap:8px;align-items:center;margin-top:12px}.check input{width:auto}@media(max-width:760px){.grid{grid-template-columns:1fr}.full{grid-column:auto}}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero"><h1>Remote Workstation MCP Setup</h1><p>Local-only onboarding for a new workstation. Configure the MCP loopback port, authorized workspace, OpenAI Secure MCP Tunnel, and ChatGPT Web handoff without exposing a public port.</p></div>
  <div class="grid">
    <section class="card"><h2>1. Workstation</h2><div id="status" class="status">Loading…</div></section>
    <section class="card"><h2>2. Runtime</h2>
      <label for="port">MCP loopback port</label><input id="port" type="number" min="1024" max="65535" />
      <label for="workspace">Authorized workspace root</label><input id="workspace" />
      <div class="check"><input id="managed" type="checkbox" /><label for="managed" style="margin:0">Use managed Cloudflare runtime material</label></div>
      <p class="muted">Leave managed Cloudflare off unless OpenAI has provisioned managed runtime material for this tunnel.</p>
    </section>
    <section class="card"><h2>3. OpenAI tunnel</h2>
      <label for="tunnel">Tunnel ID</label><input id="tunnel" placeholder="tunnel_…" autocomplete="off" />
      <label for="org">Organization ID</label><input id="org" placeholder="org-… or org_…" autocomplete="off" />
      <label for="key">Runtime API key</label><input id="key" type="password" placeholder="Paste once; never written to settings.json" autocomplete="new-password" />
      <div class="check"><input id="storeKey" type="checkbox" checked /><label for="storeKey" style="margin:0">Store runtime key with Windows DPAPI</label></div>
      <p class="secret-note">The UI never reads the saved key back. On Windows it is encrypted for the current user with DPAPI.</p>
    </section>
    <section class="card"><h2>4. ChatGPT Web</h2>
      <div class="notice">Full custom MCP apps with write/modify are currently documented for ChatGPT Business, Enterprise and Edu. The local/tunnel setup can still be completed independently of workspace entitlement.</div>
      <p class="muted">After the tunnel reports ready, open ChatGPT Apps settings, enable Developer Mode where your workspace permits it, create a custom app, choose <b>Connection: Tunnel</b>, then select or paste the tunnel ID.</p>
      <div class="row"><a class="btn secondary" target="_blank" rel="noreferrer" href="https://platform.openai.com/settings/organization/tunnels">Open Tunnels</a><a class="btn secondary" target="_blank" rel="noreferrer" href="https://platform.openai.com/settings/organization/api-keys">Runtime API keys</a><a class="btn primary" target="_blank" rel="noreferrer" href="https://chatgpt.com/#settings/Connectors">ChatGPT Apps</a></div>
    </section>
    <section class="card full"><h2>5. Apply & verify</h2>
      <div class="row"><button class="primary" id="save">Save configuration</button><button class="secondary" id="installTunnel">Install / verify tunnel-client</button><button class="secondary" id="clearKey">Remove saved API key</button><button class="secondary" id="copyTunnel">Copy tunnel ID</button></div>
      <p class="muted">After saving, start the configured connection with <code>npm run start:openai:windows</code>. The launcher will reuse these saved settings unless an environment variable explicitly overrides them.</p>
      <div id="message" class="status"></div><div id="log" class="log" hidden></div>
    </section>
  </div>
  <div class="footer">Bound to 127.0.0.1 only. Setup requests require an ephemeral local token and are rejected from other origins.</div>
</div>
<script>
const token = location.hash.startsWith('#token=') ? decodeURIComponent(location.hash.slice(7)) : '';
const headers = {'x-rwmcp-setup-token': token};
const $ = id => document.getElementById(id);
async function api(path, options={}) {
  const r = await fetch(path, {...options, headers:{...headers, ...(options.headers||{})}});
  const data = await r.json().catch(()=>({error:'Invalid response'}));
  if(!r.ok) throw new Error(data.error || ('HTTP '+r.status));
  return data;
}
function renderStatus(s){
  $('port').value=s.settings.mcpPort;$('workspace').value=s.settings.workspaceRoot;$('tunnel').value=s.settings.tunnelId||'';$('org').value=s.settings.organizationId||'';$('managed').checked=!!s.settings.cloudflaredManaged;
  $('status').innerHTML = '<span class="pill">v'+s.version+'</span><span class="pill">'+s.platform+'</span><br>'+
    'Settings: <b>'+escapeHtml(s.settingsPath)+'</b><br>'+
    'Runtime key: <b class="'+(s.runtimeApiKeyStored?'ok':'warn')+'">'+(s.runtimeApiKeyStored?'stored securely':'not stored')+'</b><br>'+
    'tunnel-client: <b class="'+(s.tunnelClientInstalled?'ok':'warn')+'">'+(s.tunnelClientInstalled?'installed':'not installed')+'</b><br>'+
    'Workspace: <b class="'+(s.workspaceExists?'ok':'warn')+'">'+(s.workspaceExists?'ready':'will be created on save')+'</b>';
}
function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function refresh(){try{renderStatus(await api('/api/status'));}catch(e){$('status').textContent=e.message;}}
$('save').onclick=async()=>{try{$('message').textContent='Saving…';const body={mcpPort:Number($('port').value),workspaceRoot:$('workspace').value.trim(),tunnelId:$('tunnel').value.trim(),organizationId:$('org').value.trim(),cloudflaredManaged:$('managed').checked,runtimeApiKey:$('key').value,storeRuntimeApiKey:$('storeKey').checked};const s=await api('/api/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});$('key').value='';$('message').innerHTML='<span class="ok">Saved.</span> '+escapeHtml(s.message);await refresh();}catch(e){$('message').innerHTML='<span class="bad">'+escapeHtml(e.message)+'</span>';}};
$('installTunnel').onclick=async()=>{try{$('message').textContent='Installing / verifying tunnel-client…';const r=await api('/api/install-tunnel-client',{method:'POST'});$('log').hidden=false;$('log').textContent=r.output;$('message').innerHTML='<span class="ok">tunnel-client ready.</span>';await refresh();}catch(e){$('message').innerHTML='<span class="bad">'+escapeHtml(e.message)+'</span>';}};
$('clearKey').onclick=async()=>{try{await api('/api/runtime-key',{method:'DELETE'});$('message').innerHTML='<span class="ok">Saved runtime key removed.</span>';await refresh();}catch(e){$('message').innerHTML='<span class="bad">'+escapeHtml(e.message)+'</span>';}};
$('copyTunnel').onclick=async()=>{const v=$('tunnel').value.trim();if(!v)return;$('message').textContent='Tunnel ID copied.';await navigator.clipboard.writeText(v);};
refresh();
</script>
</body></html>`;
}
