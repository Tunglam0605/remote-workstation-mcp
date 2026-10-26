'use strict';

const enabled = document.getElementById('enabled');
const volume = document.getElementById('volume');
const test = document.getElementById('test');
const status = document.getElementById('status');

function show(message) { status.textContent = message; }

async function refresh() {
  const config = await chrome.storage.local.get({ enabled: true, volume: 0.9 });
  enabled.checked = config.enabled !== false;
  volume.value = String(Math.round((Number.isFinite(config.volume) ? config.volume : 0.9) * 100));
  const response = await chrome.runtime.sendMessage({ type: 'rwmcp.alert.status' });
  if (!response || !response.ok) {
    show('Chưa đọc được trạng thái giọng đọc. Hãy thử lại.');
  } else if (!response.vietnameseVoiceAvailable) {
    show('⚠ Chưa có giọng tiếng Việt trên Chrome/Windows. Khi cảnh báo sẽ dùng tiếng Anh.');
  } else {
    show('✅ Đã nhận giọng đọc tiếng Việt.');
  }
}

enabled.addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: enabled.checked });
  show(enabled.checked ? 'Đã bật cảnh báo.' : 'Đã tắt cảnh báo.');
});
volume.addEventListener('change', async () => {
  await chrome.storage.local.set({ volume: Number(volume.value) / 100 });
  show('Đã lưu âm lượng.');
});
test.addEventListener('click', async () => {
  test.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'rwmcp.alert.test' });
    show(response && response.ok
      ? (response.language === 'vi-VN' ? '✅ Đang thử giọng tiếng Việt.' : '⚠ Đang thử giọng tiếng Anh (chưa có tiếng Việt).')
      : 'Không phát được âm thanh: ' + (response && (response.error || response.reason) || 'Không rõ nguyên nhân'));
  } catch (error) {
    show('Lỗi thử giọng: ' + String(error && error.message || error));
  } finally {
    test.disabled = false;
  }
});

refresh().catch(error => show('Không đọc được cấu hình: ' + String(error && error.message || error)));
