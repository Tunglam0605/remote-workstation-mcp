import { registerNotebookLmTools } from '../tools/notebooklm-tools.js';
import { registerOfficeTools } from '../tools/office-tools.js';
import { ExtensionRegistry } from './registry.js';

export function createBuiltinExtensionRegistry(): ExtensionRegistry {
  return new ExtensionRegistry()
    .add({
      id: 'productivity.office',
      version: 1,
      kind: 'productivity',
      platforms: ['win32'],
      register: registerOfficeTools
    })
    .add({
      id: 'app.notebooklm',
      version: 1,
      kind: 'app',
      register: registerNotebookLmTools
    });
}

export function registerBuiltinExtensions(...args: Parameters<ExtensionRegistry['registerAll']>) {
  return createBuiltinExtensionRegistry().registerAll(...args);
}
