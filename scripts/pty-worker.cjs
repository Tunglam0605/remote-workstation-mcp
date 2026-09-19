'use strict';

const pty = require('node-pty');

const MAX_EVENT_CHARS = 64 * 1024;
let terminal;
let startedSent = false;
let exitSent = false;

function send(message) {
  if (!process.connected || !process.send) return;
  try { process.send(message); } catch { /* parent already gone */ }
}

function sendStarted() {
  if (startedSent || !terminal) return;
  const pid = Number(terminal.pid || 0);
  if (pid > 0) {
    startedSent = true;
    send({ type: 'started', pid });
  }
}

function fail(error) {
  send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
}

function stopNative() {
  if (!terminal) return;
  try { terminal.kill(); } catch { /* best effort; parent has forced cleanup fallback */ }
}

function exitWorker(code) {
  setTimeout(() => process.exit(code), 25);
}

process.on('message', message => {
  try {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'start') {
      if (terminal) throw new Error('PTY worker already started.');
      terminal = pty.spawn(message.program, message.args, {
        name: 'xterm-256color',
        cols: message.cols,
        rows: message.rows,
        cwd: message.cwd,
        env: message.env
      });
      terminal.onData(data => {
        sendStarted();
        const bounded = data.length > MAX_EVENT_CHARS ? data.slice(-MAX_EVENT_CHARS) : data;
        send({ type: 'data', data: bounded });
      });
      terminal.onExit(event => {
        sendStarted();
        if (!exitSent) {
          exitSent = true;
          send({ type: 'exit', exitCode: event.exitCode });
        }
        exitWorker(0);
      });

      const deadline = Date.now() + 3000;
      const waitPid = () => {
        if (!terminal || startedSent || exitSent) return;
        sendStarted();
        if (startedSent) return;
        if (Date.now() >= deadline) {
          fail(new Error('PTY pid did not become available before startup deadline.'));
          stopNative();
          exitWorker(2);
          return;
        }
        setTimeout(waitPid, 10);
      };
      waitPid();
      return;
    }

    if (!terminal) throw new Error('PTY worker has no active terminal.');
    if (message.type === 'write') {
      if (typeof message.data !== 'string' || Buffer.byteLength(message.data, 'utf8') > MAX_EVENT_CHARS) {
        throw new Error('PTY worker input is invalid or oversized.');
      }
      terminal.write(message.data);
      return;
    }
    if (message.type === 'resize') {
      if (!Number.isInteger(message.cols) || !Number.isInteger(message.rows)) throw new Error('PTY resize is invalid.');
      terminal.resize(message.cols, message.rows);
      return;
    }
    if (message.type === 'stop') {
      stopNative();
    }
  } catch (error) {
    fail(error);
  }
});

process.on('disconnect', () => {
  stopNative();
  exitWorker(0);
});

process.on('uncaughtException', error => {
  fail(error);
  stopNative();
  exitWorker(2);
});

process.on('unhandledRejection', error => {
  fail(error);
  stopNative();
  exitWorker(2);
});
