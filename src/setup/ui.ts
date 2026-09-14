export function setupHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Remote Workstation MCP Setup & Control Center</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827;background:#f3f4f6}*{box-sizing:border-box}body{margin:0}.wrap{max-width:1050px;margin:32px auto;padding:0 18px}.hero{background:#111827;color:white;border-radius:18px;padding:26px;margin-bottom:18px}.hero h1{margin:0 0 8px;font-size:28px}.hero p{margin:0;color:#d1d5db;line-height:1.5}.card{background:white;border:1px solid #e5e7eb;border-radius:16px;padding:20px;box-shadow:0 4px 16px rgba(0,0,0,.04);margin-bottom:16px}.card h2{margin:0 0 12px;font-size:18px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.ready{padding:18px;border-radius:14px;border:1px solid #d1d5db;background:#f9fafb}.ready.good{background:#ecfdf3;border-color:#abefc6}.ready.warn{background:#fffaeb;border-color:#fedf89}.ready.bad{background:#fef3f2;border-color:#fecdca}label{display:block;font-size:13px;font-weight:650;margin:12px 0 6px}input{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:10px;font:inherit;background:white}button,.btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:10px;padding:10px 14px;font:inherit;font-weight:650;cursor:pointer;text-decoration:none}.primary{background:#111827;color:white}.success{background:#067647;color:white}.secondary{background:#e5e7eb;color:#111827}.danger{background:#fee2e2;color:#991b1b}.ok{color:#067647}.warntext{color:#b54708}.badtext{color:#b42318}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.muted{color:#6b7280;font-size:13px;line-height:1.55}.status{font-size:13px;line-height:1.65}.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:12px 0}.metric{border:1px solid #e5e7eb;border-radius:10px;padding:10px}.metric b{display:block;font-size:11px;color:#6b7280;margin-bottom:4px;text-transform:uppercase}.metric span{font-weight:700}.check{display:flex;gap:8px;align-items:center;margin-top:12px}.check input{width:auto}.check label{margin:0}.log{white-space:pre-wrap;background:#0b1020;color:#d1fae5;border-radius:10px;padding:12px;max-height:260px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}details{border-top:1px solid #e5e7eb;margin-top:16px;padding-top:14px}summary{font-weight:700;cursor:pointer}.footer{margin:18px 0 30px;color:#6b7280;font-size:12px}@media(max-width:850px){.grid,.metrics{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero"><h1>Remote Workstation MCP Setup & Control Center</h1><p>Prepare this Windows PC once. After the workstation and tunnel are ready, the remaining ChatGPT-side step is to add the custom MCP app and select this tunnel.</p></div>

  <section class="card">
    <h2>Quick setup for ChatGPT</h2>
    <div id="readiness" class="ready warn"><b>Checking this workstation…</b></div>
    <p class="muted">Recommended flow: fill the three OpenAI values once, then press <b>Prepare this PC for ChatGPT</b>. The wizard saves configuration, verifies tunnel-client, starts the secure tunnel and enables start-at-logon.</p>
    <div class="row">
      <button class="success" id="prepare">Prepare this PC for ChatGPT</button>
      <a class="btn primary" id="openChatGPT" target="_blank" rel="noreferrer" href="https://chatgpt.com/#settings/Connectors">Add app in ChatGPT Web</a>
      <button class="secondary" id="copyTunnel">Copy tunnel ID</button>
    </div>
    <div id="quickMessage" class="status"></div>
  </section>

  <div class="grid">
    <section class="card">
      <h2>Workstation</h2>
      <div id="status" class="status">Loading…</div>
      <label for="workspace">Authorized workspace root</label><input id="workspace" />
      <p class="muted">Only this workspace is authorized by the default policy. Existing owner policy is never silently overwritten.</p>
    </section>

    <section class="card">
      <h2>OpenAI connection</h2>
      <label for="tunnel">Tunnel ID</label><input id="tunnel" placeholder="tunnel_…" autocomplete="off" />
      <label for="org">Organization ID</label><input id="org" placeholder="org-… or org_…" autocomplete="off" />
      <label for="key">Runtime API key</label><input id="key" type="password" placeholder="Paste once; stored with Windows DPAPI" autocomplete="new-password" />
      <div class="check"><input id="storeKey" type="checkbox" checked /><label for="storeKey">Store runtime key with Windows DPAPI</label></div>
      <p class="muted">Use a restricted runtime key with Tunnels Read + Use. The saved key is never read back into the browser and is not forwarded into the MCP child process.</p>
    </section>
  </div>

  <section class="card">
    <h2>Runtime status</h2>
    <div id="runtimeMetrics" class="metrics"><div class="metric"><b>Supervisor</b><span>Loading…</span></div></div>
    <div class="row">
      <button class="primary" id="startOpenAI">Start ChatGPT tunnel</button>
      <button class="secondary" id="restart">Restart</button>
      <button class="danger" id="stop">Stop</button>
      <button class="secondary" id="refreshRuntime">Refresh</button>
      <button class="secondary" id="autostartOn">Enable start at logon</button>
      <button class="secondary" id="autostartOff">Disable start at logon</button>
    </div>
    <div id="runtimeMessage" class="status"></div>
  </section>

  <section class="card">
    <h2>Configuration</h2>
    <div class="row"><button class="primary" id="save">Save configuration</button><button class="secondary" id="installTunnel">Install / verify tunnel-client</button><button class="secondary" id="clearKey">Remove saved API key</button></div>
    <div id="message" class="status"></div><div id="log" class="log" hidden></div>
    <details>
      <summary>Advanced settings</summary>
      <label for="port">MCP loopback port</label><input id="port" type="number" min="1024" max="65535" />
      <p id="portHelp" class="muted"></p>
      <div class="check"><input id="managed" type="checkbox" /><label for="managed">Use managed Cloudflare runtime material</label></div>
      <p class="muted">Leave managed Cloudflare off unless OpenAI explicitly provisioned managed runtime material for this tunnel.</p>
      <div class="row"><a class="btn secondary" target="_blank" rel="noreferrer" href="https://platform.openai.com/settings/organization/tunnels">OpenAI Tunnels</a><a class="btn secondary" target="_blank" rel="noreferrer" href="https://platform.openai.com/settings/organization/api-keys">Runtime API keys</a></div>
    </details>
  </section>

  <div class="footer">This control surface binds only to 127.0.0.1 and requires an ephemeral local setup token. It does not expose full-control gates, permission leases or Administrator access.</div>
</div>
<script>
const token = location.hash.startsWith('#token=') ? decodeURIComponent(location.hash.slice(7)) : '';
const headers = {'x-rwmcp-setup-token': token};
const $ = id => document.getElementById(id);
let setupState=null,runtimeState=null;
async function api(path, options={}){const r=await fetch(path,{...options,headers:{...headers,...(options.headers||{})}});const data=await r.json().catch(()=>({error:'Invalid response'}));if(!r.ok)throw new Error(data.error||('HTTP '+r.status));return data;}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function renderReadiness(){if(!setupState||!runtimeState)return;const configured=!!setupState.settings.tunnelId&&setupState.runtimeApiKeyStored&&setupState.tunnelClientInstalled;const ready=configured&&runtimeState.mcpHealthy===true&&runtimeState.tunnelReady===true&&runtimeState.httpAuth==='bearer';const box=$('readiness');if(ready){box.className='ready good';box.innerHTML='<b>ChatGPT-ready on this PC.</b><br><span class="muted">MCP is healthy, bearer authentication is enabled and the OpenAI tunnel is ready. Add/select this tunnel in ChatGPT Web.</span>';}else if(configured){box.className='ready warn';box.innerHTML='<b>Configured, but the tunnel is not ready yet.</b><br><span class="muted">Press Prepare this PC for ChatGPT or Start ChatGPT tunnel.</span>';}else{box.className='ready warn';box.innerHTML='<b>First-time setup required.</b><br><span class="muted">Enter Tunnel ID, Organization ID and the restricted runtime API key, then press Prepare.</span>';}}
function renderStatus(s){setupState=s;$('port').value=s.settings.mcpPort;$('workspace').value=s.settings.workspaceRoot;$('tunnel').value=s.settings.tunnelId||'';$('org').value=s.settings.organizationId||'';$('managed').checked=!!s.settings.cloudflaredManaged;$('portHelp').innerHTML=s.configuredPortAvailable?'<span class="ok">Port '+s.settings.mcpPort+' is available.</span>':'<span class="warntext">Port '+s.settings.mcpPort+' is busy. Recommended: '+s.recommendedMcpPort+'.</span>';$('status').innerHTML='<b>Remote Workstation MCP v'+esc(s.version)+'</b><br>Runtime key: <span class="'+(s.runtimeApiKeyStored?'ok':'warntext')+'">'+(s.runtimeApiKeyStored?'stored securely':'not stored')+'</span><br>tunnel-client: <span class="'+(s.tunnelClientInstalled?'ok':'warntext')+'">'+(s.tunnelClientInstalled?'installed':'not installed')+'</span><br>Workspace: <span class="'+(s.workspaceExists?'ok':'warntext')+'">'+(s.workspaceExists?'ready':'will be created')+'</span>';renderReadiness();}
function renderRuntime(r){runtimeState=r;if(r.supported===false){$('runtimeMetrics').innerHTML='<div class="metric"><b>Runtime</b><span>Windows only</span></div>';return;}const running=r.running===true,mcp=r.mcpHealthy===true,tunnel=r.tunnelReady===true,startup=r.startupRegistered===true;$('runtimeMetrics').innerHTML='<div class="metric"><b>Supervisor</b><span class="'+(running?'ok':'warntext')+'">'+(running?'RUNNING':'STOPPED')+'</span></div><div class="metric"><b>MCP</b><span class="'+(mcp?'ok':'warntext')+'">'+(mcp?'HEALTHY':'OFFLINE')+'</span></div><div class="metric"><b>Tunnel</b><span class="'+(tunnel?'ok':'warntext')+'">'+(tunnel?'READY':'NOT READY')+'</span></div><div class="metric"><b>Auth</b><span>'+esc(r.httpAuth||'—')+'</span></div><div class="metric"><b>Start at logon</b><span class="'+(startup?'ok':'warntext')+'">'+(startup?'ON':'OFF')+'</span></div>';if(r.mcpVersion)$('runtimeMessage').innerHTML='Runtime v<b>'+esc(r.mcpVersion)+'</b> on port <b>'+esc(r.port)+'</b>.';renderReadiness();}
async function refresh(){try{renderStatus(await api('/api/status'));}catch(e){$('status').innerHTML='<span class="badtext">'+esc(e.message)+'</span>';}}
async function refreshRuntime(){try{renderRuntime(await api('/api/runtime/status'));}catch(e){$('runtimeMessage').innerHTML='<span class="badtext">'+esc(e.message)+'</span>';}}
function configBody(){return{mcpPort:Number($('port').value),workspaceRoot:$('workspace').value.trim(),tunnelId:$('tunnel').value.trim(),organizationId:$('org').value.trim(),cloudflaredManaged:$('managed').checked,runtimeApiKey:$('key').value,storeRuntimeApiKey:$('storeKey').checked};}
async function saveConfig(target='message'){const s=await api('/api/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(configBody())});$('key').value='';$(target).innerHTML='<span class="ok">Configuration saved.</span>';await refresh();return s;}
async function runtimeAction(action,mode='OpenAI',target='runtimeMessage'){try{$(target).textContent=action+'…';const r=await api('/api/runtime/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,mode})});renderRuntime(r);$(target).innerHTML='<span class="ok">'+esc(action)+' complete.</span>';return r;}catch(e){$(target).innerHTML='<span class="badtext">'+esc(e.message)+'</span>';throw e;}finally{await refresh();}}
$('prepare').onclick=async()=>{const out=$('quickMessage');try{out.textContent='1/4 Saving secure workstation configuration…';await saveConfig('quickMessage');out.textContent='2/4 Installing / verifying OpenAI tunnel-client…';const i=await api('/api/install-tunnel-client',{method:'POST'});$('log').hidden=false;$('log').textContent=i.output||'';await refresh();out.textContent='3/4 Starting secure ChatGPT tunnel…';await runtimeAction('Start','OpenAI','quickMessage');out.textContent='4/4 Enabling start at Windows logon…';await runtimeAction('RegisterStartup','OpenAI','quickMessage');await refreshRuntime();if(runtimeState&&runtimeState.mcpHealthy&&runtimeState.tunnelReady&&runtimeState.httpAuth==='bearer'){out.innerHTML='<span class="ok"><b>This PC is ready for ChatGPT.</b></span> Open ChatGPT Apps and add/select the tunnel.';}else{out.innerHTML='<span class="warntext">Setup completed, but tunnel readiness still needs attention.</span>';}}catch(e){out.innerHTML='<span class="badtext">'+esc(e.message)+'</span>';}};
$('save').onclick=async()=>{try{await saveConfig();}catch(e){$('message').innerHTML='<span class="badtext">'+esc(e.message)+'</span>';}};
$('installTunnel').onclick=async()=>{try{$('message').textContent='Installing / verifying tunnel-client…';const r=await api('/api/install-tunnel-client',{method:'POST'});$('log').hidden=false;$('log').textContent=r.output||'';$('message').innerHTML='<span class="ok">tunnel-client ready.</span>';await refresh();}catch(e){$('message').innerHTML='<span class="badtext">'+esc(e.message)+'</span>';}};
$('clearKey').onclick=async()=>{try{await api('/api/runtime-key',{method:'DELETE'});$('message').innerHTML='<span class="ok">Saved runtime key removed.</span>';await refresh();}catch(e){$('message').innerHTML='<span class="badtext">'+esc(e.message)+'</span>';}};
$('copyTunnel').onclick=async()=>{const v=$('tunnel').value.trim();if(!v)return;$('quickMessage').textContent='Tunnel ID copied.';await navigator.clipboard.writeText(v);};
$('startOpenAI').onclick=()=>runtimeAction('Start');$('restart').onclick=()=>runtimeAction('Restart');$('stop').onclick=()=>runtimeAction('Stop');$('autostartOn').onclick=()=>runtimeAction('RegisterStartup');$('autostartOff').onclick=()=>runtimeAction('UnregisterStartup');$('refreshRuntime').onclick=refreshRuntime;
refresh();refreshRuntime();
</script>
</body></html>`;
}
