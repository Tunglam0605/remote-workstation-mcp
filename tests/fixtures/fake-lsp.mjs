let buffer = Buffer.alloc(0);
let openedUri = null;
let failsafe = null;

function send(payload) {
  const json = JSON.stringify(payload);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function response(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function scheduleExit(delayMs) {
  if (failsafe) clearTimeout(failsafe);
  failsafe = setTimeout(() => process.exit(0), delayMs);
}

function onMessage(message) {
  if (message.method === 'initialize') {
    response(message.id, { capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: true, documentSymbolProvider: true } });
    scheduleExit(1500);
    return;
  }
  if (message.method === 'textDocument/didOpen') {
    openedUri = message.params.textDocument.uri;
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: openedUri,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 2, message: 'fake warning' }]
      }
    });
    return;
  }
  if (message.method === 'textDocument/definition') {
    response(message.id, { uri: openedUri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } });
    return;
  }
  if (message.method === 'textDocument/references') {
    response(message.id, [
      { uri: openedUri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
      { uri: 'file:///outside/secret.cpp', range: { start: { line: 9, character: 0 }, end: { line: 9, character: 3 } } }
    ]);
    return;
  }
  if (message.method === 'textDocument/hover') {
    response(message.id, { contents: { kind: 'markdown', value: '`int demo`' } });
    return;
  }
  if (message.method === 'textDocument/documentSymbol') {
    response(message.id, [{ name: 'demo', kind: 12, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } }]);
    scheduleExit(20);
  }
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) break;
    const body = buffer.subarray(start, end).toString('utf8');
    buffer = buffer.subarray(end);
    onMessage(JSON.parse(body));
  }
});
