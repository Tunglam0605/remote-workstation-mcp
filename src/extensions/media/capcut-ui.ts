import { WindowsSemanticUiAdapter, type WindowsUiNode } from '../../adapters/windows-semantic-ui.js';
import { CapCutDraftAdapter } from './capcut-draft.js';

function sanitizeNode(node: WindowsUiNode) {
  return {
    depth: node.depth,
    processId: node.processId,
    name: node.name,
    automationId: node.automationId,
    className: node.className,
    controlType: node.controlType,
    enabled: node.enabled,
    offscreen: node.offscreen,
    keyboardFocusable: node.keyboardFocusable,
    patterns: node.patterns
  };
}

export class CapCutUiAdapter {
  constructor(
    private readonly drafts: CapCutDraftAdapter,
    private readonly ui: WindowsSemanticUiAdapter
  ) {}

  async status() {
    const installation = await this.drafts.installationInfo();
    if (installation.platform !== 'win32') {
      return {
        supported: false,
        provider: 'capcut-windows-uia',
        reason: 'Native CapCut semantic UI automation is Windows-only.',
        installation: {
          platform: installation.platform,
          installed: installation.installed,
          version: installation.version
        }
      };
    }

    const ui = await this.ui.status().catch(error => ({
      supported: false as const,
      provider: 'windows-uia' as const,
      reason: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512)
    }));
    if (!installation.executable) {
      return {
        supported: true,
        provider: 'capcut-windows-uia',
        installation: { installed: false, version: installation.version },
        uiAutomation: ui,
        running: false,
        windowCount: 0
      };
    }

    const windows = await this.ui.windows(installation.executable).catch(error => ({
      ok: false as const,
      provider: 'windows-uia' as const,
      windowCount: 0,
      windows: [],
      error: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512)
    }));
    return {
      supported: true,
      provider: 'capcut-windows-uia',
      installation: { installed: true, version: installation.version },
      uiAutomation: ui,
      running: windows.windowCount > 0,
      windowCount: windows.windowCount,
      windows: windows.windows.map(sanitizeNode),
      safety: {
        semanticOnly: true,
        coordinateInput: false,
        rawKeyboardInput: false,
        rawMouseInput: false,
        rawUiSelectorInput: false,
        uiAccessEnabledByRwmcp: false,
        elevatedMutationAllowed: false
      }
    };
  }

  async inspect(options: { maxDepth?: number; maxNodes?: number } = {}) {
    const installation = await this.drafts.installationInfo();
    if (installation.platform !== 'win32') {
      throw new Error('CAPCUT_UI_UNAVAILABLE: semantic CapCut UI inspection is Windows-only.');
    }
    if (!installation.executable) throw new Error('CAPCUT_UI_UNAVAILABLE: CapCut executable is not installed.');
    const inspected = await this.ui.inspect(installation.executable, {
      maxDepth: options.maxDepth ?? 6,
      maxNodes: options.maxNodes ?? 512
    });
    return {
      provider: 'capcut-windows-uia',
      capcutVersion: installation.version,
      windowCount: inspected.windowCount,
      nodeCount: inspected.nodeCount,
      truncated: inspected.truncated,
      nodes: inspected.nodes.map(sanitizeNode),
      intentionallyUnavailable: [
        'screen coordinates',
        'pixel clicking',
        'raw keyboard input',
        'text-field values',
        'arbitrary executable targeting'
      ]
    };
  }
}
