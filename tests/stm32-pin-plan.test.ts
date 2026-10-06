import assert from 'node:assert/strict';
import test from 'node:test';
import { planStm32Pins, resolveCubeMxMcu, type CubeMxMcu } from '../src/adapters/engineering/stm32-cubemx-pin-db.js';

const fixture:CubeMxMcu={
  refName:'STM32TEST',
  family:'STM32F4',
  line:'TEST',
  packageName:'LQFP64',
  sourcePath:'fixture',
  pins:[
    {name:'PA9',position:'1',type:'I/O',signals:['USART1_TX','TIM1_CH2'],conditionCount:0},
    {name:'PA10',position:'2',type:'I/O',signals:['USART1_RX','TIM1_CH3'],conditionCount:0},
    {name:'PB6',position:'3',type:'I/O',signals:['I2C1_SCL','TIM4_CH1'],conditionCount:0},
    {name:'PB7',position:'4',type:'I/O',signals:['I2C1_SDA','TIM4_CH2'],conditionCount:0},
    {name:'PA13',position:'5',type:'I/O',signals:['SYS_JTMS-SWDIO'],conditionCount:0},
    {name:'PA14',position:'6',type:'I/O',signals:['SYS_JTCK-SWCLK'],conditionCount:0}
  ],
  ips:['USART1','I2C1','TIM1','TIM4']
};

test('STM32 pin planner assigns exact signals and wildcard groups without pin/signal conflicts',()=>{
  const plan=planStm32Pins(fixture,{
    exactSignals:['USART1_TX','USART1_RX'],
    groups:[{pattern:'TIM*_CH*',count:2}],
    preferredPins:{USART1_TX:['PA9']},
    preserveDebug:true
  });
  assert.equal(plan.assignments.length,4);
  assert.equal(new Set(plan.assignments.map(x=>x.pinName)).size,4);
  assert.equal(new Set(plan.assignments.map(x=>x.signal)).size,4);
  assert.equal(plan.assignments.find(x=>x.signal==='USART1_TX')?.pinName,'PA9');
  assert.equal(plan.reservedPins.includes('PA13'),true);
  assert.equal(plan.reservedPins.includes('PA14'),true);
});

test('STM32 pin planner preserves debug from unrelated allocations while allowing explicit debug requests',()=>{
  assert.throws(()=>planStm32Pins(fixture,{exactSignals:['USART1_TX','TIM1_CH2']}),/no conflict-free assignment/i);
  const explicit=planStm32Pins(fixture,{exactSignals:['SYS_JTMS-SWDIO'],preserveDebug:true});
  assert.equal(explicit.assignments[0]?.pinName,'PA13');
});

test('STM32CubeMX resolver accepts production ordering-code suffixes on installed database when present', async(t)=>{
  if(process.platform!=='win32'){t.skip('Windows CubeMX acceptance only');return;}
  const mcu=await resolveCubeMxMcu('STM32F407VET6');
  assert.equal(mcu.family,'STM32F4');
  assert.equal(mcu.packageName,'LQFP100');
  assert.ok(mcu.pins.length>=100);
  const plan=planStm32Pins(mcu,{
    exactSignals:['CAN1_RX','CAN1_TX','CAN2_RX','CAN2_TX','USART1_TX','USART1_RX','SPI1_SCK','SPI1_MISO','SPI1_MOSI','I2C1_SCL','I2C1_SDA'],
    groups:[{pattern:'TIM*_CH*',count:8}],
    preserveDebug:true
  });
  assert.equal(plan.assignments.length,19);
  assert.equal(new Set(plan.assignments.map(x=>x.pinName)).size,19);
  assert.equal(new Set(plan.assignments.map(x=>x.signal)).size,19);
  assert.equal(plan.assignments.some(x=>x.pinName==='PA13'||x.pinName==='PA14'),false);
});
