import assert from 'node:assert/strict';
import test from 'node:test';
import { NotebookLmAdapter } from '../src/web/adapters/notebooklm-adapter.js';

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
