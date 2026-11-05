// Run a headless, two-player check against an isolated throwaway game server.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const mode = process.argv[2];
const game = (mode === 'crowded'
  ? await import('./crowded.mjs')
  : mode === 'ux'
    ? await import('./ux.mjs')
    : await import('./tournament.mjs')).default;
const testRoomPassword = 'test-room-invite';

if (!process.env.BROWSER_BIN) throw Error('Set BROWSER_BIN to a Chromium headless shell executable.');
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
const backend = spawn(process.env.PYTHON || 'python3', ['-B','server.py','--port',String(port),
  '--public-origin',origin,'--data-dir',join(directory,'data')], {cwd:root,env:backendEnv,stdio:['ignore','pipe','inherit']});
let browser;
const pending = new Map(), errors = [];
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
  await send('Page.navigate', {url:origin+'/poker/'});
  return {
    async evaluate(expression) {
      const reply = await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
      return reply.result.value;
    },
    async clickAt(x, y) {
      await send('Input.dispatchMouseEvent', {type:'mousePressed', x, y, button:'left', clickCount:1});
      await send('Input.dispatchMouseEvent', {type:'mouseReleased', x, y, button:'left', clickCount:1});
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
      if(message.method==='Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if(!pending.has(message.id)) continue;
      const [resolve,reject]=pending.get(message.id);
      pending.delete(message.id);
      if(message.error) reject(Error(message.error.message)); else resolve(message.result);
    }
  });
  await Promise.race([
    Promise.all([makePage(),makePage()]).then(pages=>game(pages,sleep,testRoomPassword)),
    once(browser,'exit').then(()=>{throw Error('Browser closed before the game finished');}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Browser check exceeded 150 s')),150000);})
  ]);
  if(errors.length) throw Error(errors.join('\n'));
} finally {
  clearTimeout(timer);
  await Promise.all([stop(browser),stop(backend)]);
  rmSync(directory,{force:true,recursive:true});
}
