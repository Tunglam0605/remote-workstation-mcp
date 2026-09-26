import assert from 'node:assert/strict';
import test from 'node:test';
import { NotebookLmAdapter } from '../src/web/adapters/notebooklm-adapter.js';
import { CAPABILITIES } from '../src/capabilities.js';
import { requiredScopeForTool } from '../src/security/request-principal.js';
import { registerNotebookLmTools } from '../src/tools/notebooklm-tools.js';
import type { AppContext } from '../src/context.js';
import type { McpServer } from '@modelcontextprotocol/server';

const owner={principalId:'alice',workSessionId:'ws-1'};

function fakeChrome(){
  let closed=false;
  let clicked=false;
  let filled='';
  let extractCount=0;
  const service={
    open: async()=>({sessionId:'sess-1',tabId:17,provider:'existing-chrome-extension'}),
    close:()=>{closed=true;return{closed:true}},
    status:()=>({sessionId:'sess-1',tabId:17,provider:'existing-chrome-extension'}),
    extract: async()=>{
      extractCount++;
      if(extractCount<=2){
        return{
          url:'https://notebook.google.com/notebook/abc-123',
          title:'Demo Notebook - Gemini Notebook',
          text:'Demo Notebook 2 nguồn'
        };
      }
      if(clicked){
        return{
          url:'https://notebook.google.com/notebook/abc-123',
          title:'Demo Notebook - Gemini Notebook',
          text:'Demo Notebook 2 nguồn Question? Answer complete'
        };
      }
      return{
        url:'https://notebook.google.com/notebook/abc-123',
        title:'Demo Notebook - Gemini Notebook',
        text:'Demo Notebook 2 nguồn Question?'
      };
    },
    inspect: async()=>({
      elements:[
        {role:'checkbox',name:'Chọn tất cả các nguồn',visible:true,enabled:true},
        {role:'checkbox',name:'Chọn Source A',visible:true,enabled:true},
        {role:'checkbox',name:'Chọn Source B',visible:true,enabled:true}
      ],
      truncated:false
    }),
    find: async(_id:string,_owner:any,role:string,name:string)=>({
      matches:
        role==='textbox' && name==='Hộp truy vấn'
          ? [{elementId:'xc_1_1',visible:true,enabled:true}]
          : role==='button' && name==='Gửi'
            ? [{elementId:'xc_2_1',visible:true,enabled:true}]
            : []
    }),
    fill: async(_id:string,_owner:any,_el:string,value:string)=>{filled=value;},
    click: async()=>{clicked=true;}
  };
  return{service,meta:()=>({closed,clicked,filled})};
}

test('opens only authenticated notebook pages and returns bounded notebook metadata',async()=>{
  const fake=fakeChrome();
  const adapter=new NotebookLmAdapter(fake.service as never,async()=>{});
  const opened=await adapter.open(owner);
  assert.equal(opened.notebookId,'abc-123');
  assert.equal(opened.title,'Demo Notebook');
  assert.equal(opened.sourceCount,2);
  assert.equal(opened.authenticated,true);
});

test('lists source inventory from semantic source checkboxes',async()=>{
  const fake=fakeChrome();
  const adapter=new NotebookLmAdapter(fake.service as never,async()=>{});
  const result=await adapter.listSources('sess-1',owner);
  assert.deepEqual(result.sources,[{name:'Source A'},{name:'Source B'}]);
  assert.equal(result.sourceCount,2);
  assert.equal(result.truncated,false);
});

test('ask waits for changed stable conversation postcondition',async()=>{
  const fake=fakeChrome();
  const adapter=new NotebookLmAdapter(fake.service as never,async()=>{});
  const result=await adapter.ask('sess-1',owner,'Question?',10_000);
  assert.equal(result.completed,true);
  assert.equal(result.question,'Question?');
  assert.match(result.textSnapshot,/Answer complete/);
  assert.equal(fake.meta().filled,'Question?');
  assert.equal(fake.meta().clicked,true);
});

test('open releases Existing Chrome claim if page is not an authenticated notebook',async()=>{
  const fake=fakeChrome();
  fake.service.extract=async()=>({
    url:'https://accounts.google.com/',
    title:'Sign in',
    text:'Sign in'
  });
  const adapter=new NotebookLmAdapter(fake.service as never,async()=>{});
  await assert.rejects(adapter.open(owner),/authenticated notebook page/i);
  assert.equal(fake.meta().closed,true);
});


test('ask does not complete while NotebookLM busy markers remain visible', async () => {
  let clicked=false;
  let polls=0;
  const service={
    status:()=>({sessionId:'sess-1',tabId:17,provider:'existing-chrome-extension'}),
    extract:async()=>{
      if(!clicked) return {
        url:'https://notebook.google.com/notebook/abc-123',
        title:'Demo Notebook - Gemini Notebook',
        text:'Demo 1 nguồn'
      };
      polls++;
      if(polls<3) return {
        url:'https://notebook.google.com/notebook/abc-123',
        title:'Demo Notebook - Gemini Notebook',
        text:'Demo 1 nguồn Question? Đang suy nghĩ...'
      };
      return {
        url:'https://notebook.google.com/notebook/abc-123',
        title:'Demo Notebook - Gemini Notebook',
        text:'Demo 1 nguồn Question? Final answer'
      };
    },
    find:async(_id:string,_owner:any,role:string,name:string)=>({
      matches: role==='textbox' && name==='Hộp truy vấn'
        ? [{elementId:'xc_1_1',visible:true,enabled:true}]
        : role==='button' && name==='Gửi'
          ? [{elementId:'xc_2_1',visible:true,enabled:true}]
          : []
    }),
    fill:async()=>{},
    click:async()=>{clicked=true;},
    close:()=>({closed:true}),
    open:async()=>({sessionId:'sess-1',tabId:17,provider:'existing-chrome-extension'}),
    inspect:async()=>({elements:[],truncated:false})
  };
  const adapter=new NotebookLmAdapter(service as never,async()=>{});
  const result=await adapter.ask('sess-1',owner,'Question?',10_000);
  assert.equal(result.completed,true);
  assert.match(result.textSnapshot,/Final answer/);
  assert.ok(polls>=4);
});


test('video status distinguishes generating state and parses READY artifacts', async () => {
  const service={
    status:()=>({sessionId:'sess-1',tabId:17,provider:'existing-chrome-extension'}),
    extract:async()=>({
      url:'https://notebook.google.com/notebook/abc-123',
      title:'Demo Notebook - Gemini Notebook',
      text:'Demo 1 nguồn Studio subscriptions Existing Video 1:13 · Ngắn · 1 nguồn · 1 giờ trước play_arrow sync Đang tạo video tổng quan ngắn... Quá trình này có thể mất một chút thời gian'
    })
  };
  const adapter=new NotebookLmAdapter(service as never,async()=>{});
  const result=await adapter.videoStatus('sess-1',owner);
  assert.equal(result.state,'generating');
  assert.equal(result.busy,true);
  assert.deepEqual(result.artifacts,[{
    title:'Existing Video',
    duration:'1:13',
    format:'Ngắn',
    sourceCount:1
  }]);
});

test('video generation requires STARTED then a new stable READY artifact', async () => {
  let createClicked=false;
  let statusPolls=0;
  let filled='';
  const base='Demo 1 nguồn Studio subscriptions Existing Video 1:13 · Ngắn · 1 nguồn · 1 giờ trước play_arrow';
  const ready='Demo 1 nguồn Studio chevron_right Tổng quan bằng video collapse_content share download more_vert Xem 1 nguồn pause replay_10 forward_10 00:57 / 00:58 1x_mobiledata fullscreen_exit thumb_up Video hay thumb_down Video tệ Tổng quan bằng video "RWMCP Video" đã sẵn sàng.';
  const service={
    status:()=>({sessionId:'sess-1',tabId:17,provider:'existing-chrome-extension'}),
    extract:async()=>{
      if(!createClicked) return {
        url:'https://notebook.google.com/notebook/abc-123',
        title:'Demo Notebook - Gemini Notebook',
        text:base
      };
      statusPolls++;
      return {
        url:'https://notebook.google.com/notebook/abc-123',
        title:'Demo Notebook - Gemini Notebook',
        text: statusPolls<=2
          ? base+' sync Đang tạo video tổng quan ngắn... Quá trình này có thể mất một chút thời gian'
          : ready
      };
    },
    find:async(_id:string,_owner:any,role:string,name:string)=>({
      matches:
        role==='button' && name==='Tổng quan bằng video'
          ? [{elementId:'xc_1_1',visible:true,enabled:true}]
          : role==='textbox' && name==='Bạn muốn video này tập trung vào chủ đề gì?'
            ? [{elementId:'xc_2_1',visible:true,enabled:true}]
            : role==='button' && name==='Tạo ngay'
              ? [{elementId:'xc_3_1',visible:true,enabled:true}]
              : []
    }),
    fill:async(_id:string,_owner:any,_elementId:string,value:string)=>{filled=value;},
    click:async(_id:string,_owner:any,elementId:string)=>{if(elementId==='xc_3_1')createClicked=true;}
  };
  const adapter=new NotebookLmAdapter(service as never,async()=>{});
  const result=await adapter.videoGenerate('sess-1',owner,'Explain STM32 in a short video.',true,60_000);
  assert.equal(result.state,'ready');
  assert.equal(result.baselineArtifactCount,1);
  assert.equal(result.artifactCount,1);
  assert.equal(result.artifact?.title,'RWMCP Video');
  assert.equal(filled,'Explain STM32 in a short video.');
  assert.equal(createClicked,true);
});

test('video command mode auto-claims and releases an authenticated NotebookLM tab', async () => {
  let createClicked=false;
  let closed=false;
  let polls=0;
  const service={
    open:async()=>({sessionId:'sess-auto',tabId:23,provider:'existing-chrome-extension'}),
    close:()=>{closed=true;return{closed:true}},
    status:()=>({sessionId:'sess-auto',tabId:23,provider:'existing-chrome-extension'}),
    extract:async()=>{
      if(!createClicked) return {url:'https://notebook.google.com/notebook/abc-123',title:'Demo Notebook - NotebookLM',text:'Demo 1 sources'};
      polls++;
      return {url:'https://notebook.google.com/notebook/abc-123',title:'Demo Notebook - NotebookLM',text: polls<=2 ? 'Demo 1 sources Generating video overview' : 'Demo 1 sources Video Overview "Command Video" is ready 00:00 / 01:02 View 1 sources'};
    },
    find:async(_id:string,_owner:any,role:string,name:string)=>({matches:
      role==='button' && name==='Video Overview' ? [{elementId:'v',visible:true,enabled:true}] :
      role==='textbox' && name==='What should this video focus on?' ? [{elementId:'f',visible:true,enabled:true}] :
      role==='button' && name==='Create now' ? [{elementId:'c',visible:true,enabled:true}] : []}),
    fill:async()=>{},
    click:async(_id:string,_owner:any,elementId:string)=>{if(elementId==='c')createClicked=true;},
    inspect:async()=>({elements:[],truncated:false})
  };
  const adapter=new NotebookLmAdapter(service as never,async()=>{});
  const result=await adapter.videoGenerateCommand(owner,'Command-only generation',true,60_000);
  assert.equal(result.commandMode,true);
  assert.equal(result.autoClaimedTab,true);
  assert.equal(result.tabId,23);
  assert.equal(result.state,'ready');
  assert.equal(closed,true);
});

test('NotebookLM video tools are advertised and scope-classified', () => {
  const capability=CAPABILITIES.find(item=>item.id==='web.notebooklm');
  assert.ok(capability);
  assert.equal(capability.tools.includes('notebooklm_video_status'),true);
  assert.equal(capability.tools.includes('notebooklm_video_generate'),true);
  assert.equal(requiredScopeForTool('notebooklm_video_status'),'workstation.read');
  assert.equal(requiredScopeForTool('notebooklm_video_generate'),'workstation.write');

  const registered:string[]=[];
  const server={registerTool:(name:string)=>{registered.push(name);}} as unknown as McpServer;
  registerNotebookLmTools(server,{} as AppContext);
  assert.deepEqual(registered.sort(),[...capability.tools].sort());
});


test('video status reports READY and strips NotebookLM unread decoration from artifact titles', async () => {
  const service={
    status:()=>({sessionId:'sess-1',tabId:17,provider:'existing-chrome-extension'}),
    extract:async()=>({
      url:'https://notebook.google.com/notebook/abc-123',
      title:'Demo Notebook - Gemini Notebook',
      text:'Demo 1 nguồn Studio subscriptions Chưa đọc Fresh Video 1:04 · Ngắn · 1 nguồn · Vừa xong play_arrow'
    })
  };
  const adapter=new NotebookLmAdapter(service as never,async()=>{});
  const result=await adapter.videoStatus('sess-1',owner);
  assert.equal(result.state,'ready');
  assert.equal(result.busy,false);
  assert.equal(result.artifacts[0]?.title,'Fresh Video');
});


test('video status detects NotebookLM READY player view after card list disappears', async () => {
  const service={
    status:()=>({sessionId:'sess-1',tabId:17,provider:'existing-chrome-extension'}),
    extract:async()=>({
      url:'https://notebook.google.com/notebook/abc-123',
      title:'Demo Notebook - Gemini Notebook',
      text:'Demo 1 nguồn Studio chevron_right Tổng quan bằng video Xem 1 nguồn pause replay_10 forward_10 01:01 / 01:04 1x_mobiledata fullscreen_exit Tổng quan bằng video "Sức mạnh thực sự của vi điều khiển STM32" đã sẵn sàng.'
    })
  };
  const adapter=new NotebookLmAdapter(service as never,async()=>{});
  const result=await adapter.videoStatus('sess-1',owner);
  assert.equal(result.state,'ready');
  assert.equal(result.busy,false);
  assert.equal(result.activeArtifact?.title,'Sức mạnh thực sự của vi điều khiển STM32');
  assert.equal(result.activeArtifact?.duration,'1:04');
  assert.equal(result.activeArtifact?.sourceCount,1);
  assert.equal(result.artifacts[0]?.title,'Sức mạnh thực sự của vi điều khiển STM32');
});
