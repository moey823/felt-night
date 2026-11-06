// Run a headless, two-player check against an isolated throwaway game server.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const mode = process.argv[2];
const modes = new Set(['adjustments', 'interactions', 'crowded', 'ux', 'presentation', 'history', 'flow', 'layout', 'stability', 'compact', 'action-pacing', 'reactions', 'admin-bulk', 'lobby', 'blind-announcement']);
const suite = modes.has(mode) ? mode : 'tournament';
const game = (await import('./' + suite + '.mjs')).default;
const testRoomPassword = 'test-room-invite';

if (!process.env.BROWSER_BIN) throw Error('Set BROWSER_BIN to a Chromium headless shell executable.');
if (process.env.QA_SCREEN_DIR) mkdirSync(process.env.QA_SCREEN_DIR, {recursive:true});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const directory = mkdtempSync(join(tmpdir(), 'sitngo-tournament-'));
const root = fileURLToPath(new URL('../../', import.meta.url));
const portFinder = createServer();
portFinder.listen(0, '127.0.0.1');
await once(portFinder, 'listening');
const port = portFinder.address().port;
await new Promise(resolve => portFinder.close(resolve));
const origin = 'http://127.0.0.1:' + port;
const backendEnv = {...process.env};
delete backendEnv.FELT_NIGHT_ROOM_PASSWORD_FILE;
backendEnv.FELT_NIGHT_ROOM_PASSWORD = testRoomPassword;
backendEnv.FELT_NIGHT_ADMIN_USERNAME = 'admin';
const backend = spawn(process.env.PYTHON || 'python3', ['-B','server.py','--port',String(port),
  '--public-origin',origin,'--data-dir',join(directory,'data')], {cwd:root,env:backendEnv,stdio:['ignore','pipe','inherit']});
let browser;
let pages = [];
const pending = new Map(), errors = [];
const targetInfos = new Map();
let serial = 0;
async function command(method, params = {}, sessionId) {
  const id = ++serial;
  return new Promise((resolve,reject) => {
    pending.set(id, [resolve,reject]);
    browser.stdio[3].write(JSON.stringify({id,method,params,sessionId}) + '\0');
  });
}
async function makePage() {
  const {browserContextId} = await command('Target.createBrowserContext');
  const {targetId} = await command('Target.createTarget',{url:'about:blank',browserContextId});
  const {sessionId} = await command('Target.attachToTarget',{targetId,flatten:true});
  const send = (method, params) => command(method, params, sessionId);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setFocusEmulationEnabled',{enabled:true});
  if (suite !== 'lobby') await send('Page.addScriptToEvaluateOnNewDocument',{source:`(() => {
    window.__FELT_NIGHT_TEST_WINDOW_CALLS__ = location.protocol === "about:" ? [] : JSON.parse(sessionStorage.getItem("feltNightTestWindows") || "[]");
    window.__FELT_NIGHT_TEST_OPEN__ = function(url, target, features) {
      const call = {url:String(url || ""),target:String(target || ""),features:String(features || "")};
      window.__FELT_NIGHT_TEST_WINDOW_CALLS__.push(call);
      sessionStorage.setItem("feltNightTestWindows", JSON.stringify(window.__FELT_NIGHT_TEST_WINDOW_CALLS__));
      if (String(url || "") === "about:blank") {
        const placeholder = {closed:false};
        let destination = "about:blank";
        Object.defineProperty(placeholder, "location", {
          get() { return destination; },
          set(next) {
            destination = String(next);
            if (destination !== "about:blank") window.setTimeout(() => window.location.assign(destination), 0);
          }
        });
        return placeholder;
      }
      if (url) { window.setTimeout(() => window.location.assign(String(url)), 0); return window; }
      return null;
    };
    window.open = window.__FELT_NIGHT_TEST_OPEN__;
  })();`});
  await send('Page.navigate', {url:origin+'/poker/'});
  return {
    targetId,
    browserContextId,
    async waitForPopup(timeoutMs = 10000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const popupInfo = [...targetInfos.values()].find(info => info.type === 'page' && info.targetId !== targetId && info.browserContextId === browserContextId && (info.url.startsWith(origin + '/poker/table') || info.url.startsWith(origin + '/table')));
        if (popupInfo) {
          const popupTargetId = popupInfo.targetId;
          const {sessionId:popupSessionId} = await command('Target.attachToTarget',{targetId:popupTargetId,flatten:true});
          const popupSend = (method, params) => command(method, params, popupSessionId);
          await popupSend('Runtime.enable');
          await popupSend('Page.enable');
          await popupSend('Network.enable');
          return {
            targetId:popupTargetId,
            browserContextId,
            async evaluate(expression) {
              const reply = await popupSend('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
              if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
              return reply.result.value;
            },
            async cookies(url) {
              const result = await popupSend('Network.getCookies',{urls:[url]});
              return result.cookies || [];
            },
            async close() { await command('Target.closeTarget',{targetId:popupTargetId}); }
          };
        }
        await sleep(50);
      }
      throw Error('No popup target appeared for ' + targetId);
    },
    async cookies(url) {
      const result = await send('Network.getCookies',{urls:[url]});
      return result.cookies || [];
    },
    async evaluate(expression) {
      const reply = await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
      return reply.result.value;
    },
    async clickAt(x, y, clickCount = 1) {
      await send('Input.dispatchMouseEvent', {type:'mousePressed', x, y, button:'left', clickCount});
      await send('Input.dispatchMouseEvent', {type:'mouseReleased', x, y, button:'left', clickCount});
    },
    async pressAt(x, y) {
      await send('Input.dispatchMouseEvent', {type:'mouseMoved', x, y});
      await send('Input.dispatchMouseEvent', {type:'mousePressed', x, y, button:'left', buttons:1, clickCount:1});
    },
    async releaseAt(x, y) {
      await send('Input.dispatchMouseEvent', {type:'mouseReleased', x, y, button:'left', buttons:0, clickCount:1});
    },
    async dragAt(startX, startY, endX, endY) {
      await send('Input.dispatchMouseEvent', {type:'mouseMoved',x:startX,y:startY});
      await send('Input.dispatchMouseEvent', {type:'mousePressed',x:startX,y:startY,button:'left',buttons:1,clickCount:1});
      for (let step=1;step<=12;step++) {
        await send('Input.dispatchMouseEvent', {type:'mouseMoved',
          x:startX+(endX-startX)*step/12,y:startY+(endY-startY)*step/12,button:'left',buttons:1});
      }
      await send('Input.dispatchMouseEvent', {type:'mouseReleased',x:endX,y:endY,button:'left',buttons:0,clickCount:1});
    },
    async screenshot(name) {
      if(!process.env.QA_SCREEN_DIR) return;
      const {data} = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      writeFileSync(join(process.env.QA_SCREEN_DIR,name+'.png'),Buffer.from(data,'base64'));
    },
    async pressEscape() {
      const key = {key:'Escape',code:'Escape',windowsVirtualKeyCode:27};
      await send('Input.dispatchKeyEvent',{type:'keyDown',...key});
      await send('Input.dispatchKeyEvent',{type:'keyUp',...key});
    },
    async pressEnter() {
      const key = {key:'Enter',code:'Enter',windowsVirtualKeyCode:13};
      await send('Input.dispatchKeyEvent',{type:'keyDown',...key});
      await send('Input.dispatchKeyEvent',{type:'char',text:'\r',...key});
      await send('Input.dispatchKeyEvent',{type:'keyUp',...key});
    },
    async bringToFront() {
      await send('Emulation.setFocusEmulationEnabled',{enabled:true});
      await command('Target.activateTarget',{targetId});
      await send('Page.bringToFront');
      await new Promise(resolve => setTimeout(resolve, 200));
      const visibility = await send('Runtime.evaluate',{
        expression:'document.visibilityState',returnByValue:true,
      });
      if (visibility?.result?.value !== 'visible') {
        throw Error('Target did not become visible: ' + String(visibility?.result?.value));
      }
    },
    async wheelAt(x, y, deltaY, modifiers = 0) {
      await this.bringToFront();
      await send('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:0,deltaY,modifiers});
    },
    reload() {
      return send('Page.reload',{ignoreCache:true});
    },
    resize(width,height) {
      return send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<800});
    }
  };
}
async function stop(child) {
  if (!child?.pid || child.exitCode!==null || child.signalCode!==null) return;
  const exit = once(child,'exit');
  child.kill();
  await exit;
}
let timer;
try {
  await Promise.race([once(backend.stdout,'data'), once(backend,'exit').then(()=>{throw Error('Test server failed to start');})]);
  browser = spawn(process.env.BROWSER_BIN,['--remote-debugging-pipe','--disable-gpu','--disable-background-networking',
    '--user-data-dir='+join(directory,'browser'),'about:blank'],{stdio:['ignore','ignore','ignore','pipe','pipe']});
  browser.stdio[4].setEncoding('utf8');
  let buffer='';
  browser.stdio[4].on('data', data=>{
    buffer+=data;
    for(let end;(end=buffer.indexOf('\0'))!==-1;) {
      const message=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1);
      if(message.method==='Target.targetCreated' || message.method==='Target.targetInfoChanged') {
        targetInfos.set(message.params.targetInfo.targetId, message.params.targetInfo);
      }
      if(message.method==='Target.targetDestroyed') targetInfos.delete(message.params.targetId);
      if(message.method==='Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if(!pending.has(message.id)) continue;
      const [resolve,reject]=pending.get(message.id);
      pending.delete(message.id);
      if(message.error) reject(Error(message.error.message)); else resolve(message.result);
    }
  });
  await command('Target.setDiscoverTargets',{discover:true});
  await Promise.race([
    Promise.all([makePage(),makePage()]).then(createdPages=>{ pages=createdPages; return game(createdPages,sleep,testRoomPassword); }),
    once(browser,'exit').then(()=>{throw Error('Browser closed before the game finished');}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Browser check exceeded 150 s')),150000);})
  ]);
  if(errors.length) throw Error(errors.join('\n'));
} catch (error) {
  if(process.env.QA_SCREEN_DIR) {
    for(let index=0;index<pages.length;index++) {
      const page=pages[index];
      try {
        await page.screenshot("failure-"+(index+1));
      } catch (captureError) {
        console.error("Failure screenshot "+(index+1)+" could not be captured: "+String(captureError));
      }
      try {
        const snapshot=await page.evaluate('(() => { const rect=s => { const n=document.querySelector(s); if(!n) return null; const r=n.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; }; const d=document.documentElement,b=document.body; return {viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY,width:d.scrollWidth,height:d.scrollHeight,bodyHeight:b.scrollHeight},tableView:rect("#table-view"),tableSurface:rect("#table-surface"),felt:rect("#felt"),actionPanel:rect("#action-panel")}; })()');
        console.error("Failure viewport "+(index+1)+": "+JSON.stringify(snapshot));
      } catch (captureError) {
        console.error("Failure geometry "+(index+1)+" could not be read: "+String(captureError));
      }
    }
  }
  throw error;
} finally {
  clearTimeout(timer);
  await Promise.all([stop(browser),stop(backend)]);
  rmSync(directory,{force:true,recursive:true});
}
