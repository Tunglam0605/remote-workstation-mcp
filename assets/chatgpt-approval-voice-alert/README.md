# RWMCP Approval Voice Alert — Chrome extension (v0.1.0 prototype)

Standalone read-only Chrome extension; it does NOT change installed RWMCP, authorize
a tool, click Allow, or use any RWMCP/API tokens. The existing NotebookLM Chrome
Bridge remains untouched.

## Purpose

If a visible ChatGPT tool-permission dialog contains a specific approval button
(Allow / Always Allow / Cho phép / Luôn cho phép) and tool-permission context,
announce a fixed message on the PC:

"Anh Tùng Lâm ơi! ChatGPT đang cần anh cấp quyền để tiếp tục công việc.
Anh quay lại xác nhận giúp em nhé!"

If Chrome has no vi-VN voice, use an understandable **English** reminder rather
than pretend the Vietnamese text can be pronounced correctly. The popup indicates
whether a Vietnamese voice is available. OS voice installation is a separate
owner-approved step; this extension NEVER installs language packs.

## User controls

- Enabled toggle (default ON after explicit extension installation).
- Volume slider (default 90%).
- "Thử giọng đọc" button; works even if alerting is disabled, for testing.
- Fixed 30-second reminder, at most 3 attempts per continuously visible dialog.
- Global 8-second cross-tab speech cooldown avoids simultaneous alerts from two tabs.
- Alerts stop after the modal closes or the toggle is disabled.

## Install to OWNER Chrome (explicit owner action)

1. On the Windows PC, open Chrome and visit chrome://extensions.
2. Turn **Developer mode** on; choose **Load unpacked**.
3. Select this folder:
   C:\Users\Admin\Documents\RemoteWorkspaces\remote-workstation-mcp.rwmcp-8a24878b-f748-4428-b745-823d2e34b922\assets\chatgpt-approval-voice-alert
4. Verify Chrome displays only the two ChatGPT site matches and permission to
   use speech/storage. Do NOT accept unexpected broad host permissions.
5. Reload the existing ChatGPT tab(s), open the extension popup, press
   **Thử giọng đọc**, check the volume and the installed voice status.
6. During NORMAL work, wait for an actual tool permission dialog.
   Confirm the alert starts, repeats no more than 3 times while the modal is
   visible, and stops once you resolve/close the dialog.
7. Disable/remove the extension at chrome://extensions if it fails or becomes
   disruptive. This does not uninstall or affect RWMCP itself.

## Privacy and safety

- Manifest content script runs only at chatgpt.com and chat.openai.com.
- Observes DOM changes; inspects only text and visible buttons inside candidate
  role=dialog / role=alertdialog elements, entirely inside the browser.
- Sends ONLY a fixed event type to its own extension service worker.
- Persists enabled, volume and a local detection timestamp; no chat data is saved.
- No network, no page clicking, no cookie/localStorage reads, no permission
  bypass, no shell, no remote filesystem operations.

## Engineering verification

From the RWMCP worktree (Node.js >=22):

- node --test tests/approval-voice-alert.test.ts
- node tests/fixtures/approval-voice-alert-smoke.mjs
  (requires playwright-core npm dependency and a downloaded Chromium)
- npm run verify

The Chromium smoke script uses a disposable profile and intercepts a synthetic
ChatGPT-origin URL with fake HTML. No real ChatGPT session or active owner
Chrome tabs are opened or modified.

## Known limitations — MUST BE VERIFIED with actual ChatGPT approval UI

The synthetic Chromium smoke does **not** prove real ChatGPT permission-dialog
compatibility or audibility on the owner's speakers. ChatGPT can change its DOM,
render dialogs in inaccessible cross-origin frames, native UI, or component
surfaces without a role=dialog. Those are not detectable by this implementation.
The extension cannot intercept an approval before the browser has rendered it.
The reminder timers may be throttled in suspended/background browser tabs.
No screenshot polling is performed.

Release candidate status requires a successful owner-Chrome test with the real
UI and audible voice; until then this is a separate preview, not an RWMCP patch.
