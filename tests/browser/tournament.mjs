// Two isolated browsers play on a disposable development server.
// See README for the headless test command.
export default async function game([one, two], sleep) {
  const pages = [one, two];
  const ev = (p, fn, ...args) => p.evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  async function wait(p, fn, ...args) {
    for (let i = 0; i < 100; i++) {
      const value = await ev(p, fn, ...args);
      if (value) return value;
      await sleep(125);
    }
    throw Error('Timed out: ' + fn + ' ' + args + ' | ' + await ev(p, () => document.body.innerText.slice(-1600)));
  }
  const visible = s => !!document.querySelector(s)?.offsetWidth;
  const click = (p, s) => wait(p, q => {const n=document.querySelector(q); if(!n?.offsetWidth || n.disabled) return false; n.click(); return true;}, s);
  const input = (p, s, value) => ev(p, (q,v) => {const n=document.querySelector(q); n.value=String(v); for(const e of ['input','change']) n.dispatchEvent(new Event(e,{bubbles:true}));}, s, value);
  const submit = (p, s) => ev(p, q => document.querySelector(q).requestSubmit(), s);
  for (const [i,p] of pages.entries()) {
    await wait(p, visible, '#login-name'); await input(p, '#login-name', ['Robin','Morgan'][i]);
    await input(p,'#login-password','example-room-invite'); await submit(p,'#login-form'); await wait(p, visible, '#app-panel');
  }
  async function create(name, extra = {}) {
    for(const [s,v] of Object.entries({'#table-name':name,'#max-seats':2,'#level-minutes':79,'#turn-seconds':47,'#runout-seconds':1.25,...extra})) await input(one,s,v);
    await submit(one,'#create-form');
    await wait(one,n=>document.querySelector('#view-table-name')?.textContent===n,name);
    await wait(two,n=>{const e=[...document.querySelectorAll('[data-open-table]')].find(e=>e.innerText.includes(n)); if(!e) return false; e.click(); return true;},name);
    await click(two,'[data-take-seat="1"]');
    for (const [s,v] of [['#settings-level-minutes','79'],['#settings-turn-seconds', String(extra['#turn-seconds'] ?? 47)],['#settings-runout-seconds','1.25']]) {
      if(await ev(one,s=>document.querySelector(s).value,s)!==v) throw Error('Create value not restored: '+s);
    }
    await input(one,'#settings-runout-seconds','1.75'); await click(one,'#save-settings-button');
    await wait(one,()=>!document.querySelector('#start-button').disabled && document.querySelector('#settings-runout-seconds').value==='1.75');
    await click(one,'#start-button');
  }
  async function actor() {
    for(let i=0;i<110;i++) {
      for(const p of pages) if(await ev(p,visible,'#action-panel:not([hidden]) #action-controls button:not([disabled])')) return p;
      await sleep(125);
    }
    throw Error('No actionable controls');
  }
  async function confirm(p) {
    await click(p,'[data-action="confirm-all-in"]');
  }
  const name='Release check '+Date.now(); await create(name);
  await one.resize(320,740); await two.resize(1280,800);
  for(const p of pages) await ev(p,()=>{
    window.historyQA=[]; window.flightsQA=[];
    new MutationObserver(rs=>{for(const r of rs) for(const n of r.addedNodes) if(n.nodeType===1 && n.matches('.chip-flight')) window.flightsQA.push([n.className,n.textContent]);}).observe(document.querySelector('#chip-layer'),{childList:true});
    window.setInterval(()=>{
      const board=[...document.querySelectorAll('#board-cards .playing-card')].filter(e=>e.innerText.trim()).length;
      const odds=[...document.querySelectorAll('.seat-equity')].filter(e=>e.offsetWidth).map(e=>[e.dataset.playerId,e.innerText]);
      const stamp=JSON.stringify([board,odds]); if(window.historyQA.at(-1)!==stamp) window.historyQA.push(stamp);
    },75);
  });
  for(let attempt=0;attempt<4;attempt++) {
    const first=await actor(), other=first===one?two:one;
    const range='#action-controls input[type=range]';
    await wait(first,visible,range);
    const max=await ev(first,q=>Number(document.querySelector(q).max),range);
    if(!max || await ev(first,visible,'[data-poker-action="all_in"]')) throw Error('No unified raise range');
    await input(first,range,max);
    await click(first,'[data-poker-action="raise_to"]'); await confirm(first);
    await wait(other,visible,'[data-poker-action="call"]');
    if(await ev(other,visible,'.seat-equity')) throw Error('Odds appeared while action still pending');
    await click(other,'[data-poker-action="call"]'); await confirm(other);
    for(const p of pages) await wait(p,visible,'.seat-equity');
    await wait(one,()=>[...document.querySelectorAll('#board-cards .playing-card')].filter(e=>e.innerText.trim()).length===5);
    await wait(one,visible,'#hand-result .hand-result-recipient');
    if(await ev(one,()=>document.querySelector('#hand-status-label').innerText.includes('COMPLETE'))) break;
    await wait(one,()=>document.querySelector('#action-panel').offsetWidth || document.querySelector('.seat-turn-clock')?.offsetWidth);
  }
  for(const p of pages) {
    await wait(p,visible,'#dismiss-results-button');
    const info=await ev(p,()=>({history:window.historyQA.map(JSON.parse), flights:window.flightsQA, pots:document.querySelector('#hand-result')?.innerText, standings:document.querySelector('#results-panel').innerText, overflow:document.documentElement.scrollWidth>innerWidth+1}));
    for(let n=0;n<=5;n++) if(!info.history.some(([count,odds])=>count===n && odds.length===2 && new Set(odds.map(o=>o[0])).size===2 && odds.every(o=>o[1].includes('%')))) throw Error('Missing exposed odds at board size '+n+' '+JSON.stringify(info.history));
    if(!info.standings.includes('Robin') || !info.standings.includes('Morgan') || !info.pots || !/2,?000/.test(info.pots) || info.overflow) throw Error(JSON.stringify(info));
    if(!info.flights.some(f=>/payout|award/.test(f[0]))) throw Error('No payout movement '+JSON.stringify(info.flights));
    await click(p,'#dismiss-results-button'); await click(p,'#reopen-results-button'); await wait(p,visible,'#dismiss-results-button');
    console.log('Tournament complete:',info.standings.replace(/\s+/g,' '),'|',info.pots.replace(/\s+/g,' '));
  }
  // Play a second table without committing both stacks. The big blind must
  // have a free check, and a normal bet must use the exact slider amount.
  for (const p of pages) {
    await click(p,'#dismiss-results-button'); await click(p,'#close-table-button');
    await wait(p,visible,'#table-list');
  }
  await create('Check and fold '+Date.now());
  const sb=await actor(), bb=sb===one?two:one;
  await click(sb,'[data-poker-action="call"]'); await wait(bb,visible,'[data-poker-action="check"]');
  if(await ev(bb,visible,'[data-poker-action="fold"]')) throw Error('Fold offered when checking is free');
  await click(bb,'[data-poker-action="check"]');
  await wait(bb,()=>document.querySelector('#street-label').textContent==='FLOP');
  const bettor=await actor(), folder=bettor===one?two:one;
  const range='#action-controls input[type=range]';
  await input(bettor,range,37); await click(bettor,'[data-poker-action="raise_to"]');
  await wait(folder,s=>document.querySelector(s)?.innerText.includes('37'),'[data-poker-action="call"]');
  await click(folder,'[data-poker-action="fold"]');
  for(const p of pages) await wait(p,visible,'#hand-result .hand-result-recipient');
  console.log('Checked free, bet exactly 37 with slider, and folded facing a bet.');

  // A short stack can raise only to one legal value; a confirmation must
  // not survive the turn it was opened for.
  for (const p of pages) {await click(p,'#close-table-button'); await wait(p,visible,'#table-list');}
  await create('Short raise '+Date.now(),{'#starting-stack':100,'#small-blind':40,'#big-blind':60,'#turn-seconds':5});
  const short=await actor();
  const singleton=await ev(short,()=>{const r=document.querySelector('#raise-amount');return [r?.min,r?.max,r?.value];});
  if(singleton.join(',')!=='100,100,100')throw Error('Wrong short-shove bound '+singleton);
  await click(short,'[data-poker-action="raise_to"]');
  await wait(short,visible,'[data-action="confirm-all-in"]');
  await wait(short,()=>!document.querySelector('#allInConfirm').open);
  await wait(short,()=>document.querySelector('#hand-result')?.innerText.includes('80'));
  console.log('Only legal short raise selected; confirmation expired and no shove was submitted.');

}
