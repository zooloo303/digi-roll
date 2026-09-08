import assert from 'node:assert/strict';
// Simulated MIDI; no gear needed. PLAYWRIGHT_MODULE points to a dev install.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.LAB_ORIGIN || 'http://127.0.0.1:8765';
const browser=await chromium.launch({headless:true});
try {
 const context=await browser.newContext({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36'});
 for(const file of ['difflab.html','console.html','index.html']) {
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   window.reply=false;
   const timer=window.setTimeout.bind(window);
   window.setTimeout=(fn,ms,...args)=>timer(fn,ms===5000?30:ms,...args);
   navigator.requestMIDIAccess=async()=>{
    const {parseSysEx,buildApiMessage}=await import('/js/elektron/protocol.js');
    const input={id:'in',name:'Elektron Digitone II',handlers:new Set(),addEventListener(t,f){this.handlers.add(f)},removeEventListener(t,f){this.handlers.delete(f)}};
    const output={id:'out',name:input.name,send(raw){
     const m=parseSysEx(raw);if(!window.reply||m.kind!=='api')return;
     const ascii=s=>[...s].map(c=>c.charCodeAt(0));
     const bytes=buildApiMessage(1,m.apiId+128,m.apiId===1?[43,0,...ascii('Digitone II'),0]:[...ascii('0050'),0,...ascii('1.10E'),0],m.msgId);
     for(const f of input.handlers)f({data:bytes});
    }};
    return {inputs:new Map([['in',input]]),outputs:new Map([['out',output]])};
   };
  });
  await page.goto(origin+'/'+file);
  if(file==='index.html'){
   await page.selectOption('#output','out');await page.click('[data-panel="boxPanel"]');await page.click('#impFetch');
  }else{await page.selectOption('#port','out');await page.click('#connect');}
  await page.locator('#midiConnectionHelp').waitFor({state:'visible'});
  assert.match(await page.locator('#midiConnectionHelp').innerText(),/Chrome 152/);
  assert.equal(await page.locator('#midiConnectionHelp a').getAttribute('target'),'_blank');
  await page.evaluate(()=>window.reply=true);
  if(file==='index.html')await page.click('#impFetch');else await page.click('#connect');
  await page.locator('#midiConnectionHelp').waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);
  console.log(file,'timeout guidance and successful identity retry passed');
  await page.close();
 }
 const page=await context.newPage();await page.goto(origin+'/midi-help.html');
 assert.equal(await page.locator('h1').innerText(),'MIDI connection help');
 assert.equal((await page.request.get(origin+'/scripts/digi-roll-chrome.command')).status(),200);
}finally{await browser.close();}
