import { registerNotebookLmTools } from '../tools/notebooklm-tools.js';
import { registerOfficeTools } from '../tools/office-tools.js';
import { registerCanTools } from './can/register.js';
import { registerCanopenTools } from './canopen/register.js';
import { registerModbusTools } from './modbus/register.js';
import { registerModbusTcpTools } from './modbus-tcp/register.js';
import { registerMqttTools } from './mqtt/register.js';
import { registerOpcUaTools } from './opcua/register.js';
import { registerRos2Tools } from './ros2/register.js';
import { registerStm32Tools } from './stm32/register.js';
import { registerEsp32Tools } from './esp32/register.js';
import { registerKicadTools } from './kicad/register.js';
import { ExtensionRegistry } from './registry.js';

export function createBuiltinExtensionRegistry(): ExtensionRegistry {
  return new ExtensionRegistry()
    .add({
      id: 'domain.can',
      version: 1,
      kind: 'domain',
      platforms: ['linux'],
      register: registerCanTools
    })
    .add({
      id: 'domain.canopen',
      version: 1,
      kind: 'domain',
      platforms: ['linux'],
      register: registerCanopenTools
    })
    .add({
      id: 'domain.mqtt',
      version: 1,
      kind: 'domain',
      register: registerMqttTools
    })
    .add({
      id: 'domain.opcua',
      version: 1,
      kind: 'domain',
      register: registerOpcUaTools
    })
    .add({
      id: 'domain.modbus-tcp',
      version: 1,
      kind: 'domain',
      register: registerModbusTcpTools
    })
    .add({
      id: 'domain.modbus-rtu',
      version: 1,
      kind: 'domain',
      register: registerModbusTools
    })
    .add({
      id: 'domain.stm32',
      version: 1,
      kind: 'domain',
      register: registerStm32Tools
    })
    .add({
      id: 'domain.esp32',
      version: 1,
      kind: 'domain',
      register: registerEsp32Tools
    })
    .add({
      id: 'domain.kicad',
      version: 1,
      kind: 'domain',
      register: registerKicadTools
    })
    .add({
      id: 'domain.ros2',
      version: 1,
      kind: 'domain',
      register: registerRos2Tools
    })
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
