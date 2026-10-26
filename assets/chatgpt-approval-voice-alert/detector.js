'use strict';

// Pure, deliberately conservative heuristic. No chat content leaves the page.
(() => {
  const normalize = value => String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const APPROVE_BUTTONS = new Set([
    'allow', 'always allow', 'allow once',
    'approve', 'approve once',
    'cho phép', 'luôn cho phép', 'cho phép một lần',
    'phê duyệt', 'đồng ý cấp quyền'
  ]);
  const PERMISSION_CONTEXT = /\b(permission|approve|approval|tool|connector|mcp|action|access request)\b|cấp quyền|phê duyệt|yêu cầu quyền|công cụ|ứng dụng/iu;

  function isApprovalDialog(input) {
    if (!input || input.visible !== true || !Array.isArray(input.buttons)) return false;
    const buttons = input.buttons.map(normalize);
    if (!buttons.some(button => APPROVE_BUTTONS.has(button))) return false;
    return PERMISSION_CONTEXT.test(normalize(input.text));
  }

  globalThis.RwmcpApprovalDetector = Object.freeze({ isApprovalDialog });
})();
