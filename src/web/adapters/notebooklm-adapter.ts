import type { ExistingChromeSessionService } from '../existing-chrome-session.js';

type Owner = { principalId: string; workSessionId: string };

const QUERY_NAMES = ['Hộp truy vấn', 'Query box', 'Ask a question'];
const SEND_NAMES = ['Gửi', 'Send'];

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const BUSY_PATTERNS = [
  /Đang suy nghĩ/i,
  /Đang thu thập thông tin/i,
  /Đang tìm kiếm/i,
  /Đang tạo câu trả lời/i,
  /Thinking/i,
  /Gathering information/i,
  /Searching/i,
  /Generating (?:an )?answer/i
];

function responseBusy(text: string): boolean {
  return BUSY_PATTERNS.some(pattern => pattern.test(text));
}

function notebookIdFromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/\/notebook\/([a-zA-Z0-9-]+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function notebookTitle(title: string): string {
  return title
    .replace(/\s*-\s*Gemini Notebook\s*$/i, '')
    .replace(/\s*-\s*NotebookLM\s*$/i, '')
    .trim()
    .slice(0, 256);
}

function sourceCountFromText(text: string): number | undefined {
  const match = text.match(/(?:^|\s)(\d+)\s*(?:nguồn|sources?)(?:\s|·|$)/i);
  return match ? Number(match[1]) : undefined;
}

function sourceNameFromCheckbox(name: string): string | undefined {
  const cleaned = normalize(name);
  if (/^Chọn tất cả(?: các)? nguồn$/i.test(cleaned) || /^Select all sources?$/i.test(cleaned)) return undefined;
  const vi = cleaned.match(/^Chọn\s+(.+)$/i);
  if (vi?.[1]) return normalize(vi[1]);
  const en = cleaned.match(/^Select\s+(.+)$/i);
  if (en?.[1]) return normalize(en[1]);
  return undefined;
}

export class NotebookLmAdapter {
  constructor(
    private readonly chrome: ExistingChromeSessionService,
    private readonly sleep: (ms: number) => Promise<void> = delay
  ) {}

  async open(owner: Owner, requestedTabId?: number) {
    const opened = await this.chrome.open(owner, requestedTabId);
    try {
      const status = await this.status(opened.sessionId, owner);
      if (!status.authenticated || !status.notebookId) {
        throw new Error('NotebookLM authenticated notebook page is required.');
      }
      return { ...opened, ...status };
    } catch (error) {
      this.chrome.close(opened.sessionId, owner);
      throw error;
    }
  }

  close(existingSessionId: string, owner: Owner) {
    return this.chrome.close(existingSessionId, owner);
  }

  async status(existingSessionId: string, owner: Owner) {
    const session = this.chrome.status(existingSessionId, owner);
    const extracted = await this.chrome.extract(existingSessionId, owner, 12_000) as any;
    const rawUrl = typeof extracted?.url === 'string' ? extracted.url : '';
    const rawTitle = typeof extracted?.title === 'string' ? extracted.title : '';
    const text = typeof extracted?.text === 'string' ? extracted.text : '';
    const notebookId = notebookIdFromUrl(rawUrl);
    const authenticated = Boolean(notebookId) &&
      !/accounts\.google\.com/i.test(rawUrl) &&
      !/couldn.?t sign you in|sign in/i.test(rawTitle);
    return {
      existingSessionId: session.sessionId,
      tabId: session.tabId,
      provider: session.provider,
      authenticated,
      notebookId,
      title: notebookTitle(rawTitle),
      url: rawUrl.slice(0, 2048),
      sourceCount: sourceCountFromText(text)
    };
  }

  async listSources(existingSessionId: string, owner: Owner) {
    const status = await this.status(existingSessionId, owner);
    if (!status.authenticated) throw new Error('NotebookLM authentication is required.');
    const inspected = await this.chrome.inspect(existingSessionId, owner, 50) as any;
    const elements = Array.isArray(inspected?.elements) ? inspected.elements : [];
    const sources: { name: string }[] = [];
    const seen = new Set<string>();
    for (const element of elements) {
      if (element?.role !== 'checkbox' || typeof element?.name !== 'string') continue;
      const name = sourceNameFromCheckbox(element.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      sources.push({ name });
    }
    return {
      existingSessionId,
      notebookId: status.notebookId,
      sources,
      sourceCount: status.sourceCount ?? sources.length,
      truncated: typeof status.sourceCount === 'number'
        ? status.sourceCount > sources.length
        : Boolean(inspected?.truncated)
    };
  }

  private async findFirst(
    existingSessionId: string,
    owner: Owner,
    role: string,
    names: string[],
    requireEnabled = true
  ) {
    for (const name of names) {
      const result = await this.chrome.find(existingSessionId, owner, role, name, 10) as any;
      const matches = Array.isArray(result?.matches) ? result.matches : [];
      const selected = matches.find((item: any) =>
        item?.visible !== false && (!requireEnabled || item?.enabled !== false));
      if (selected?.elementId) return selected;
    }
    return undefined;
  }

  async ask(existingSessionId: string, owner: Owner, question: string, timeoutMs = 60_000) {
    const prompt = normalize(question);
    if (!prompt || prompt.length > 8_000) {
      throw new Error('NotebookLM question must be 1 to 8000 characters.');
    }

    const status = await this.status(existingSessionId, owner);
    if (!status.authenticated) throw new Error('NotebookLM authentication is required.');

    const baseline = await this.chrome.extract(existingSessionId, owner, 16_000) as any;
    const baselineText = typeof baseline?.text === 'string' ? baseline.text : '';

    const query = await this.findFirst(existingSessionId, owner, 'textbox', QUERY_NAMES);
    if (!query) throw new Error('NotebookLM query textbox was not found.');
    await this.chrome.fill(existingSessionId, owner, query.elementId, prompt);

    const send = await this.findFirst(existingSessionId, owner, 'button', SEND_NAMES, true);
    if (!send) {
      throw new Error('NotebookLM send button did not become actionable after filling the question.');
    }
    await this.chrome.click(existingSessionId, owner, send.elementId);

    const deadline = Date.now() + Math.max(5_000, Math.min(timeoutMs, 120_000));
    let changed = false;
    let stablePolls = 0;
    let previous = '';
    let latest = baselineText;

    while (Date.now() < deadline) {
      await this.sleep(750);
      const extracted = await this.chrome.extract(existingSessionId, owner, 16_000) as any;
      latest = typeof extracted?.text === 'string' ? extracted.text : '';
      const normalizedLatest = normalize(latest);
      const busy = responseBusy(normalizedLatest);
      if (latest !== baselineText && normalizedLatest.includes(prompt)) changed = true;

      if (changed && !busy) {
        if (latest === previous) stablePolls += 1;
        else stablePolls = 0;
        if (stablePolls >= 2) {
          return {
            existingSessionId,
            notebookId: status.notebookId,
            completed: true,
            question: prompt,
            textSnapshot: latest.slice(-6_000),
            observedAt: new Date().toISOString()
          };
        }
      }
      previous = latest;
    }

    throw new Error('NotebookLM response did not reach a stable postcondition before timeout.');
  }
}
