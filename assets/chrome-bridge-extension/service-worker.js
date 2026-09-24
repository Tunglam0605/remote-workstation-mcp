'use strict';

const HOST = 'com.tunglam.rwmcp.chrome_bridge';
const MAX_TEXT = 16000;
const ALLOWED = new Set(['status','tabs.list','page.inspect','page.find','page.extract','page.click','page.fill']);

let port;
let reconnectTimer;

function allowedUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      (url.hostname === 'notebooklm.google.com' || url.hostname === 'notebook.google.com');
  } catch {
    return false;
  }
}

async function allowedTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter(tab => typeof tab.id === 'number' && allowedUrl(tab.url || ''));
}

async function checkedTab(tabId) {
  if (!Number.isInteger(tabId)) throw Object.assign(new Error('tabId is required.'), { code: 'INVALID_TAB' });
  const tab = await chrome.tabs.get(tabId);
  if (!allowedUrl(tab.url || '')) throw Object.assign(new Error('Tab is outside the NotebookLM allowlist.'), { code: 'DOMAIN_DENIED' });
  return tab;
}

async function contentCommand(tabId, message) {
  await checkedTab(tabId);
  try {
    const result = await chrome.tabs.sendMessage(tabId, message);
    if (!result || result.ok !== true) {
      throw Object.assign(new Error(result?.error?.message || 'Content bridge request failed.'), {
        code: result?.error?.code || 'CONTENT_ERROR'
      });
    }
    return result.result;
  } catch (error) {
    if (error?.code) throw error;
    throw Object.assign(new Error(error?.message || 'NotebookLM content script is unavailable.'), { code: 'CONTENT_UNAVAILABLE' });
  }
}

async function execute(command, payload) {
  if (!ALLOWED.has(command)) throw Object.assign(new Error('Bridge command is not allowed.'), { code: 'COMMAND_DENIED' });

  if (command === 'status' || command === 'tabs.list') {
    const tabs = await allowedTabs();
    const bounded = tabs.slice(0, 32).map(tab => ({
      tabId: tab.id,
      windowId: tab.windowId,
      active: Boolean(tab.active),
      title: String(tab.title || '').slice(0, 256),
      url: String(tab.url || '').slice(0, 2048)
    }));
    if (command === 'status') {
      return {
        bridgeVersion: chrome.runtime.getManifest().version,
        extensionId: chrome.runtime.id,
        connected: true,
        tabCount: bounded.length,
        tabs: bounded
      };
    }
    return { tabs: bounded, truncated: tabs.length > bounded.length };
  }

  const tabId = Number(payload?.tabId);
  if (command === 'page.inspect') {
    const maxItems = Math.max(1, Math.min(50, Number(payload?.maxItems ?? 30)));
    return await contentCommand(tabId, { op: 'inspect', maxItems });
  }
  if (command === 'page.find') {
    const role = String(payload?.role || '').slice(0, 32);
    const name = String(payload?.name || '').slice(0, 256);
    const maxItems = Math.max(1, Math.min(50, Number(payload?.maxItems ?? 20)));
    return await contentCommand(tabId, { op: 'find', role, name, maxItems });
  }
  if (command === 'page.extract') {
    const maxChars = Math.max(1, Math.min(MAX_TEXT, Number(payload?.maxChars ?? 8000)));
    return await contentCommand(tabId, { op: 'extract', maxChars });
  }
  if (command === 'page.click') {
    const elementId = String(payload?.elementId || '').slice(0, 96);
    return await contentCommand(tabId, { op: 'click', elementId });
  }
  if (command === 'page.fill') {
    const elementId = String(payload?.elementId || '').slice(0, 96);
    const value = String(payload?.value ?? '').slice(0, 8000);
    return await contentCommand(tabId, { op: 'fill', elementId, value });
  }
  throw Object.assign(new Error('Unsupported bridge command.'), { code: 'COMMAND_DENIED' });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, 1500);
}

function connect() {
  if (port) return;
  let nextPort;
  try {
    nextPort = chrome.runtime.connectNative(HOST);
  } catch {
    scheduleReconnect();
    return;
  }
  port = nextPort;

  nextPort.onMessage.addListener(async message => {
    if (!message || message.type !== 'bridge_request' || typeof message.id !== 'string') return;
    try {
      const result = await execute(message.command, message.payload || {});
      if (port !== nextPort) return;
      nextPort.postMessage({ type: 'bridge_response', id: message.id, ok: true, result });
    } catch (error) {
      if (port !== nextPort) return;
      nextPort.postMessage({
        type: 'bridge_response',
        id: message.id,
        ok: false,
        error: {
          code: String(error?.code || 'BRIDGE_ERROR').slice(0, 64),
          message: String(error?.message || 'Bridge request failed.').slice(0, 1024)
        }
      });
    }
  });

  nextPort.onDisconnect.addListener(() => {
    if (port !== nextPort) return;
    port = undefined;
    scheduleReconnect();
  });

  nextPort.postMessage({
    type: 'bridge_hello',
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version
  });
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();
