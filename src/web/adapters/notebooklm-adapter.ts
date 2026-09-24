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

const VIDEO_BUSY_PATTERNS = [
  /Đang tạo video tổng quan/i,
  /Quá trình này có thể mất một chút thời gian/i,
  /Creating video overview/i,
  /Generating video overview/i
];

const VIDEO_FAILURE_PATTERNS = [
  /Không thể tạo[^.]{0,80}video/i,
  /Không tạo được[^.]{0,80}video/i,
  /Failed to (?:create|generate)[^.]{0,80}video/i,
  /Video generation failed/i
];

type NotebookLmVideoArtifact = {
  title: string;
  duration: string;
  format: string;
  sourceCount: number;
};

function videoBusy(text: string): boolean {
  return VIDEO_BUSY_PATTERNS.some(pattern => pattern.test(text));
}

function videoFailure(text: string): string | undefined {
  const pattern = VIDEO_FAILURE_PATTERNS.find(candidate => candidate.test(text));
  return pattern ? text.match(pattern)?.[0]?.slice(0, 256) : undefined;
}

function videoArtifactKey(artifact: NotebookLmVideoArtifact): string {
  return `${artifact.title}\u0000${artifact.duration}\u0000${artifact.sourceCount}`;
}

function normalizeDuration(value: string): string {
  return value.replace(/^0+(?=\d:)/, '');
}

function activeVideoArtifactFromText(text: string): NotebookLmVideoArtifact | undefined {
  const normalized = normalize(text);
  const titleMatch =
    normalized.match(/Tổng quan bằng video\s+["“](.+?)["”]\s+đã sẵn sàng/i) ??
    normalized.match(/Video Overview\s+["“](.+?)["”]\s+is ready/i);
  if (!titleMatch?.[1]) return undefined;

  const durationMatch = normalized.match(/\d{1,2}:\d{2}\s*\/\s*(\d{1,2}:\d{2})/);
  const sourceMatch =
    normalized.match(/Xem\s+(\d+)\s+nguồn/i) ??
    normalized.match(/View\s+(\d+)\s+sources?/i);
  if (!durationMatch?.[1] || !sourceMatch?.[1]) return undefined;

  return {
    title: cleanVideoTitle(titleMatch[1]),
    duration: normalizeDuration(durationMatch[1]),
    format: 'unknown',
    sourceCount: Number(sourceMatch[1])
  };
}

function cleanVideoTitle(value: string): string {
  return normalize(value).replace(/^(?:Chưa đọc|Unread)\s+/i, '').trim();
}

function videoArtifactsFromText(text: string): NotebookLmVideoArtifact[] {
  const normalized = normalize(text);
  const result: NotebookLmVideoArtifact[] = [];
  const seen = new Set<string>();
  const pattern = /(\d{1,2}:\d{2})\s*·\s*(Ngắn|Video giải thích|Short|Explainer)\s*·\s*(\d+)\s*(?:nguồn|sources?)/gi;
  for (const match of normalized.matchAll(pattern)) {
    const index = match.index ?? 0;
    const before = normalized.slice(Math.max(0, index - 240), index);
    const marker = before.lastIndexOf('subscriptions ');
    if (marker < 0) continue;
    const title = cleanVideoTitle(before.slice(marker + 'subscriptions '.length));
    if (!title || title.length > 220 || /Tổng quan bằng video/i.test(title)) continue;
    const artifact = {
      title: title.slice(0, 220),
      duration: match[1]!,
      format: match[2]!,
      sourceCount: Number(match[3])
    };
    const key = videoArtifactKey(artifact);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(artifact);
  }
  const active = activeVideoArtifactFromText(text);
  if (active) {
    const key = videoArtifactKey(active);
    if (!seen.has(key)) result.unshift(active);
  }
  return result;
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

  async videoStatus(existingSessionId: string, owner: Owner) {
    const status = await this.status(existingSessionId, owner);
    if (!status.authenticated) throw new Error('NotebookLM authentication is required.');
    const extracted = await this.chrome.extract(existingSessionId, owner, 16_000) as any;
    const text = typeof extracted?.text === 'string' ? extracted.text : '';
    const failure = videoFailure(text);
    const busy = videoBusy(text);
    const artifacts = videoArtifactsFromText(text);
    const activeArtifact = activeVideoArtifactFromText(text);
    return {
      existingSessionId,
      notebookId: status.notebookId,
      state: failure ? 'failed' as const : busy ? 'generating' as const : artifacts.length > 0 ? 'ready' as const : 'idle' as const,
      busy,
      failure,
      activeArtifact,
      artifacts,
      observedAt: new Date().toISOString()
    };
  }

  async videoGenerate(
    existingSessionId: string,
    owner: Owner,
    focus: string,
    waitForReady = true,
    timeoutMs = 15 * 60_000
  ) {
    const prompt = normalize(focus);
    if (!prompt || prompt.length > 8_000) {
      throw new Error('NotebookLM video focus must be 1 to 8000 characters.');
    }

    const baseline = await this.videoStatus(existingSessionId, owner);
    if (baseline.busy) throw new Error('RESOURCE_BUSY: NotebookLM is already generating a video.');
    if (baseline.failure) throw new Error(`NotebookLM reports a previous video generation failure: ${baseline.failure}`);

    const overview = await this.findFirst(
      existingSessionId,
      owner,
      'button',
      ['Tổng quan bằng video', 'Video Overview']
    );
    if (!overview) throw new Error('NotebookLM Video Overview control was not found.');
    await this.chrome.click(existingSessionId, owner, overview.elementId);

    const focusBox = await this.findFirst(
      existingSessionId,
      owner,
      'textbox',
      ['Bạn muốn video này tập trung vào chủ đề gì?', 'What should this video focus on?']
    );
    if (!focusBox) throw new Error('NotebookLM video focus textbox was not found.');
    await this.chrome.fill(existingSessionId, owner, focusBox.elementId, prompt);

    const create = await this.findFirst(
      existingSessionId,
      owner,
      'button',
      ['Tạo ngay', 'Create now']
    );
    if (!create) throw new Error('NotebookLM Create now button was not found.');
    await this.chrome.click(existingSessionId, owner, create.elementId);

    const startDeadline = Date.now() + 12_000;
    let started = await this.videoStatus(existingSessionId, owner);
    while (!started.busy && !started.failure && Date.now() < startDeadline) {
      await this.sleep(500);
      started = await this.videoStatus(existingSessionId, owner);
    }
    if (started.failure) throw new Error(`NotebookLM video generation failed to start: ${started.failure}`);
    if (!started.busy) {
      throw new Error('NotebookLM did not expose a video-generation busy postcondition after Create now.');
    }

    const startedAt = new Date().toISOString();
    if (!waitForReady) {
      return {
        existingSessionId,
        notebookId: started.notebookId,
        state: 'generating' as const,
        started: true,
        startedAt,
        baselineArtifactCount: baseline.artifacts.length,
        focus: prompt
      };
    }

    const deadline = Date.now() + Math.max(30_000, Math.min(timeoutMs, 30 * 60_000));
    const baselineArtifactKeys = new Set(baseline.artifacts.map(videoArtifactKey));
    let latest = started;
    let stableReadyPolls = 0;
    let previousNewArtifactKey = '';

    while (Date.now() < deadline) {
      await this.sleep(5_000);
      latest = await this.videoStatus(existingSessionId, owner);
      if (latest.failure) throw new Error(`NotebookLM video generation failed: ${latest.failure}`);

      const newArtifacts = latest.artifacts.filter(artifact => !baselineArtifactKeys.has(videoArtifactKey(artifact)));
      const preferredNewArtifact =
        latest.activeArtifact && !baselineArtifactKeys.has(videoArtifactKey(latest.activeArtifact))
          ? latest.activeArtifact
          : newArtifacts[0];
      const newArtifactKey = JSON.stringify(newArtifacts);
      if (!latest.busy && preferredNewArtifact) {
        stableReadyPolls = newArtifactKey === previousNewArtifactKey ? stableReadyPolls + 1 : 0;
        if (stableReadyPolls >= 1) {
          return {
            existingSessionId,
            notebookId: latest.notebookId,
            state: 'ready' as const,
            started: true,
            startedAt,
            readyAt: new Date().toISOString(),
            focus: prompt,
            baselineArtifactCount: baseline.artifacts.length,
            artifactCount: latest.artifacts.length,
            artifact: preferredNewArtifact,
            artifacts: latest.artifacts
          };
        }
      } else {
        stableReadyPolls = 0;
      }
      previousNewArtifactKey = newArtifactKey;
    }

    throw new Error('NotebookLM video generation did not reach a READY artifact postcondition before timeout.');
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
