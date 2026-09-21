import { spawn } from 'node:child_process';
import type { AdminRequest } from './approval-store.js';

const CONTROL_CENTER_URL = 'http://127.0.0.1:8684/#approvals';

function compact(value: string, max: number): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, max);
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function windowsApprovalToastCommand(): string {
  return encodedPowerShell(String.raw`
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$toastNode = $xml.SelectSingleNode('/toast')
$toastNode.SetAttribute('launch', $env:RWMCP_NOTIFY_URL)
$toastNode.SetAttribute('activationType', 'protocol')
$texts = $xml.GetElementsByTagName('text')
[void]$texts.Item(0).AppendChild($xml.CreateTextNode($env:RWMCP_NOTIFY_TITLE))
[void]$texts.Item(1).AppendChild($xml.CreateTextNode($env:RWMCP_NOTIFY_BODY))
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Remote Workstation MCP')
$notifier.Show($toast)
`);
}

export function notifyOwnerApprovalRequest(request: AdminRequest): void {
  if (process.env.RWMCP_DISABLE_OWNER_NOTIFICATIONS === '1' || process.env.CI === 'true') return;
  const title = 'Remote Workstation MCP cần phê duyệt';
  const reason = compact(request.reason || 'Yêu cầu quyền Administrator mới.', 180);
  const program = compact(request.program, 100);
  const body = program ? `${reason} · ${program}` : reason;

  if (process.platform === 'win32') {
    try {
      const child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-ExecutionPolicy', 'Bypass', '-EncodedCommand', windowsApprovalToastCommand()
      ], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          RWMCP_NOTIFY_TITLE: title,
          RWMCP_NOTIFY_BODY: body,
          RWMCP_NOTIFY_URL: CONTROL_CENTER_URL
        }
      });
      child.unref();
    } catch {
      // Approval creation must never fail because desktop notification delivery failed.
    }
  }
}
