'use strict';

// Only examine visible modal text and button labels to classify a permission
// prompt. Never send modal text, chat content, cookies or approval decisions.
(() => {
  const detector = globalThis.RwmcpApprovalDetector;
  if (!detector) return;

  const SURFACES = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const REMINDER_MS = 30_000;
  const MAX_ALERTS = 3;
  let enabled = true;
  let active = false;
  let alerts = 0;
  let reminder = null;
  let scanTimer = null;
  let disposed = false;

  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    if (element.closest('[aria-hidden="true"], [inert]')) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
  }

  function approvalVisible() {
    for (const modal of document.querySelectorAll(SURFACES)) {
      if (!isVisible(modal)) continue;
      const buttons = Array.from(modal.querySelectorAll('button, [role="button"]'))
        .filter(isVisible)
        .map(button => button.getAttribute('aria-label') || button.innerText || button.textContent || '')
        .slice(0, 16);
      const text = String(modal.innerText || modal.textContent || '').slice(0, 1400);
      if (detector.isApprovalDialog({ visible: true, buttons, text })) return true;
    }
    return false;
  }

  function reset() {
    active = false;
    alerts = 0;
    if (reminder !== null) clearTimeout(reminder);
    reminder = null;
  }

  function announceIfPending() {
    reminder = null;
    if (disposed || !enabled || !active || !approvalVisible()) {
      reset();
      return;
    }
    if (alerts >= MAX_ALERTS) return;
    alerts += 1;
    chrome.runtime.sendMessage({ type: 'rwmcp.approval.alert' }).catch(() => {
      // The browser may suspend its worker. Never retry without a timer.
    });
    if (alerts < MAX_ALERTS) reminder = setTimeout(announceIfPending, REMINDER_MS);
  }

  function scan() {
    scanTimer = null;
    if (disposed || !enabled) return reset();
    if (approvalVisible()) {
      if (!active) {
        active = true;
        alerts = 0;
        announceIfPending();
      }
    } else if (active) reset();
  }

  function scheduleScan() {
    if (disposed || !enabled) return;
    if (scanTimer !== null) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 180);
  }

  chrome.storage.local.get({ enabled: true })
    .then(result => {
      enabled = result.enabled !== false;
      if (enabled) scheduleScan();
    })
    .catch(() => { enabled = false; });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.enabled) return;
    enabled = changes.enabled.newValue !== false;
    reset();
    if (enabled) scheduleScan();
  });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'aria-hidden', 'aria-modal', 'data-state']
  });
  window.addEventListener('pagehide', () => {
    disposed = true;
    observer.disconnect();
    if (scanTimer !== null) clearTimeout(scanTimer);
    reset();
  }, { once: true });
})();
