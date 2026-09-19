import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBuildDiagnostics } from '../src/adapters/build-diagnostics.js';

test('parseBuildDiagnostics parses GCC and Clang diagnostics', () => {
  const input = [
    'src/main.cpp:42:10: error: no member named push in std::vector<int>',
    'src/util.cpp:17:5: warning: unused variable result [-Wunused-variable]',
    'src/util.cpp:17:5: warning: unused variable result [-Wunused-variable]'
  ].join('\n');

  const report = parseBuildDiagnostics(input, 20);
  assert.equal(report.truncated, false);
  assert.equal(report.diagnostics.length, 2);
  assert.deepEqual(report.diagnostics[0], {
    file: 'src/main.cpp',
    line: 42,
    column: 10,
    severity: 'error',
    message: 'no member named push in std::vector<int>',
    raw: 'src/main.cpp:42:10: error: no member named push in std::vector<int>'
  });
  assert.equal(report.diagnostics[1]?.severity, 'warning');
});

test('parseBuildDiagnostics parses MSVC and CMake diagnostics', () => {
  const input = [
    'C:\\work\\main.cpp(12,7): error C2065: identifier: undeclared identifier',
    'CMake Error at CMakeLists.txt:24 (add_executable):'
  ].join('\n');

  const report = parseBuildDiagnostics(input, 20);
  assert.equal(report.diagnostics.length, 2);
  assert.equal(report.diagnostics[0]?.file, 'C:\\work\\main.cpp');
  assert.equal(report.diagnostics[0]?.line, 12);
  assert.equal(report.diagnostics[0]?.column, 7);
  assert.equal(report.diagnostics[0]?.code, 'C2065');
  assert.equal(report.diagnostics[1]?.code, 'add_executable');
  assert.equal(report.diagnostics[1]?.severity, 'error');
});

test('parseBuildDiagnostics bounds output', () => {
  const input = Array.from({ length: 5 }, (_, index) => `src/f${index}.c:${index + 1}:1: error: boom ${index}`).join('\n');
  const report = parseBuildDiagnostics(input, 2);
  assert.equal(report.diagnostics.length, 2);
  assert.equal(report.truncated, true);
});


test('parseBuildDiagnostics parses Keil ARMCC and linker diagnostics', () => {
  const input = [
    '..\\Src\\main.c(123): error:  #20: identifier "missing" is undefined',
    '..\\Src\\util.c(45): warning:  #177-D: variable "temp" was declared but never referenced',
    'Error: L6218E: Undefined symbol HAL_Init (referred from main.o).'
  ].join('\n');

  const report = parseBuildDiagnostics(input, 20);
  assert.equal(report.diagnostics.length, 3);
  assert.deepEqual(report.diagnostics[0], {
    file: '..\\Src\\main.c',
    line: 123,
    column: undefined,
    severity: 'error',
    code: '#20',
    message: 'identifier "missing" is undefined',
    raw: '..\\Src\\main.c(123): error:  #20: identifier "missing" is undefined'
  });
  assert.equal(report.diagnostics[1]?.code, '#177-D');
  assert.equal(report.diagnostics[1]?.severity, 'warning');
  assert.equal(report.diagnostics[2]?.code, 'L6218E');
  assert.equal(report.diagnostics[2]?.severity, 'error');
});
