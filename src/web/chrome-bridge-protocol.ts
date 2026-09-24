export const CHROME_BRIDGE_HOST = 'com.tunglam.rwmcp.chrome_bridge';
export const CHROME_BRIDGE_EXTENSION_ID = 'agffdgankgdnlkmimcojiojbkgneneei';
export const CHROME_BRIDGE_PIPE = '\\\\.\\pipe\\rwmcp-chrome-bridge-v1';
export const CHROME_BRIDGE_MAX_MESSAGE_BYTES = 256 * 1024;

export const CHROME_BRIDGE_COMMANDS = [
  'status',
  'tabs.list',
  'page.inspect',
  'page.find',
  'page.extract',
  'page.click',
  'page.fill'
] as const;

export type ChromeBridgeCommand = typeof CHROME_BRIDGE_COMMANDS[number];

export interface ChromeBridgeRequest {
  type: 'request';
  id: string;
  command: ChromeBridgeCommand;
  payload?: Record<string, unknown>;
}

export interface ChromeBridgeResponse {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}
