'use strict';

// Speech only: never clicks, approves, accesses chat history, or requests network.
const MESSAGE_VI = 'Anh Tùng Lâm ơi! ChatGPT đang cần anh cấp quyền để tiếp tục công việc. Anh quay lại xác nhận giúp em nhé!';
const MESSAGE_EN = 'Tung Lam, ChatGPT is waiting for your permission. Please return to approve the request.';
const TRUSTED_ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com']);
const DEFAULT_SETTINGS = { enabled: true, volume: 0.9 };
const ALERT_COOLDOWN_MS = 8000;
let lastAlertAt = 0;

function isOwnerTab(sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab || !Number.isInteger(sender.tab.id)) return false;
  try {
    return TRUSTED_ORIGINS.has(new URL(sender.url).origin);
  } catch {
    return false;
  }
}

async function readSettings() {
  const saved = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    enabled: saved.enabled !== false,
    volume: Number.isFinite(saved.volume) ? Math.max(0, Math.min(1, saved.volume)) : DEFAULT_SETTINGS.volume
  };
}

async function speak(messageType) {
  const settings = await readSettings();
  if (!settings.enabled && messageType !== 'rwmcp.alert.test') return { ok: false, reason: 'disabled' };
  if (messageType === 'rwmcp.approval.alert' && Date.now() - lastAlertAt < ALERT_COOLDOWN_MS) {
    return { ok: true, suppressed: true };
  }

  const voices = await chrome.tts.getVoices();
  const vietnameseVoice = voices.find(voice => /^vi([-_]|$)/i.test(voice.lang || ''));
  const language = vietnameseVoice ? 'vi-VN' : 'en-US';
  const message = vietnameseVoice ? MESSAGE_VI : MESSAGE_EN;
  const voiceOption = vietnameseVoice ? { voiceName: vietnameseVoice.voiceName } : {};
  // Record before speaking to prevent two simultaneous ChatGPT tabs from both shouting.
  if (messageType === 'rwmcp.approval.alert') {
    lastAlertAt = Date.now();
    // Local timestamp only: proof that an approval was recognized, no prompt text.
    await chrome.storage.local.set({ lastDetectedAt: lastAlertAt });
  }
  await chrome.tts.stop();
  await chrome.tts.speak(message, { lang: language, volume: settings.volume, enqueue: false, ...voiceOption });
  return { ok: true, language, vietnameseVoiceAvailable: Boolean(vietnameseVoice) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  const isTest = type === 'rwmcp.alert.test' &&
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL('popup.html');
  const isAlert = type === 'rwmcp.approval.alert' && isOwnerTab(sender);
  const isStatus = type === 'rwmcp.alert.status' && isTestSender(sender);
  if (!(isTest || isAlert || isStatus)) return false;

  if (isStatus) {
    Promise.all([readSettings(), chrome.tts.getVoices()])
      .then(([settings, voices]) => sendResponse({
        ok: true,
        settings,
        vietnameseVoiceAvailable: voices.some(voice => /^vi([-_]|$)/i.test(voice.lang || ''))
      }))
      .catch(error => sendResponse({ ok: false, error: String(error && error.message || error) }));
    return true;
  }

  speak(type).then(sendResponse).catch(error => {
    sendResponse({ ok: false, error: String(error && error.message || error) });
  });
  return true;
});

function isTestSender(sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
}
