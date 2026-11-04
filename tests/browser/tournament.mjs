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
  await wait(one,visible,'#login-name');
  const assets=await ev(one,async()=>{
    const security=document.querySelector('a[href="/poker/security.html"]'),favicon=document.querySelector('link[rel=icon]');
    const page=await fetch(security.href), icon=await fetch(favicon.href);
    return page.ok && icon.ok && icon.headers.get('content-type')?.startsWith('image/svg+xml') && (await page.text()).includes('SystemRandom');
  });
  if(!assets) throw Error('The fair-play guide or ace favicon is unavailable');
  for (const [i,p] of pages.entries()) {
    await wait(p, visible, '#login-name'); await click(p,'#auth-switch'); await input(p, '#login-name', ['Robin','Morgan'][i]);
    await input(p,'#login-password','poker-test-password'); await input(p,'#room-password','example-room-invite'); await submit(p,'#login-form'); await wait(p, visible, '#app-panel');
  }
  async function create(name, extra = {}) {
    if(await ev(one,visible,'#create-game-tab')) await click(one,'#create-game-tab');
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
      for(const p of pages) if(await ev(p,visible,'#action-panel:not([hidden]) #action-controls [data-poker-action]:not([disabled])')) return p;
      await sleep(125);
    }
    throw Error('No actionable controls');
  }
  async function verifyLeftmost(p, action) {
    const pass=await ev(p, wanted=>{
      const buttons=[...document.querySelectorAll('#action-controls [data-poker-action]')].filter(n=>n.offsetWidth);
      const first=buttons.find(n=>n.dataset.pokerAction===wanted);
      return first && buttons.every(n=>first.getBoundingClientRect().left <= n.getBoundingClientRect().left+1);
    },action);
    if(!pass) throw Error(action+' must be the leftmost play action');
  }
  const pre='[data-preaction="check-fold"]';
  async function clickPre(p) {
    await wait(p, visible, pre);
    const [x,y] = await ev(p, q => {
      const button = document.querySelector(q);
      button.scrollIntoView({block:'center'});
      const rect = button.getBoundingClientRect();
      return [rect.left + rect.width/2, rect.top + rect.height/2];
    }, pre);
    await p.clickAt(x,y);
  }
  async function togglePre(p,selected) {
    await clickPre(p);
    await wait(p,(q,v)=>{const e=document.querySelector(q);return e && !e.disabled && e.getAttribute('aria-pressed')===String(v);},pre,selected);
  }
  async function confirm(p) {
    await click(p,'[data-action="confirm-all-in"]');
  }
  const name='Release check '+Date.now(); await create(name,{'#buy-in':13,'#payout':'75, 25','#max-seats':9});
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
    if (attempt === 0) {
      await first.resize(320,740); await other.resize(1280,800);
      await ev(first,()=>document.querySelector('#action-panel').scrollIntoView({block:'center'}));
      await first.screenshot('mobile-actions');
      const layout=await ev(first,()=>{
        const cards=[...document.querySelectorAll('.is-viewer-cards .mini-card')];
        const controls=[...document.querySelectorAll('#action-controls button')];
        const issues=[];
        if(cards.length!==2) issues.push('missing hole cards');
        if(document.querySelectorAll('#seat-grid .seat-card').length!==2) issues.push('nine-seat lobby did not compact to two entrants');
        for(const n of [...cards,...controls]) {
          const b=n.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
          if(cards.includes(n)) {
            const dock=document.querySelector('#action-panel').getBoundingClientRect();
            if(b.left<0 || b.right>innerWidth || b.top<0 || b.bottom>innerHeight || (b.left<dock.right && b.right>dock.left && b.top<dock.bottom && b.bottom>dock.top)) issues.push(n.textContent+' not visible alongside the dock');
          } else if(!b.width || !hit || !(n===hit || n.contains(hit))) issues.push(n.textContent+' obstructed or offscreen');
        }
        return issues;
      });
      if(layout.length) throw Error('320px table layout: '+layout.join(', '));
      for (const w of [390,1280]) {
        await first.resize(w,w===390?844:800);
        await sleep(150);
        await ev(first,()=>document.querySelector('#action-panel').scrollIntoView({block:'center'}));
        const separation=await ev(first,()=>{
          const box=q=>document.querySelector(q).getBoundingClientRect();
          const hero=box('.is-viewer-cards'), dock=box('#action-panel');
          return {gap:dock.left-hero.right, sharedHeight:Math.min(hero.bottom,dock.bottom)-Math.max(hero.top,dock.top),overflow:document.documentElement.scrollWidth>innerWidth};
        });
        await first.screenshot('actions-'+w);
        if(separation.gap < -1 || separation.sharedHeight<=0 || separation.overflow) throw Error(w+'px actions must sit beside the cards: '+JSON.stringify(separation));
      }
      await first.resize(320,740);
    }
    await click(first,'[data-raise-preset][data-target="50"]');
    if(await ev(first,q=>Number(document.querySelector(q).value),range)!==50) throw Error('2.5 BB did not select 50');
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
    if(info.history.some(([n])=>n===1 || n===2)) throw Error('Partial flop displayed');
    for(const n of [0,3,4,5]) if(!info.history.some(([count,odds])=>count===n && odds.length===2 && new Set(odds.map(o=>o[0])).size===2 && odds.every(o=>o[1].includes('%')))) throw Error('Missing exposed odds at board size '+n+' '+JSON.stringify(info.history));
    if(/\bchips\b/i.test(info.standings) || !info.standings.includes('26 play credits awarded') || !info.standings.includes('20 credits') || !info.standings.includes('6 credits') || !info.standings.includes('Robin') || !info.standings.includes('Morgan') || !info.pots || !/2,?000/.test(info.pots) || info.overflow) throw Error(JSON.stringify(info));
    if(!info.flights.some(f=>/payout|award/.test(f[0]))) throw Error('No payout movement '+JSON.stringify(info.flights));
    await click(p,'#dismiss-results-button'); await click(p,'#reopen-results-button'); await wait(p,visible,'#dismiss-results-button');
    await click(p,'#dismiss-results-button');
    await click(p,'#history-button');
    await wait(p,(n)=>document.querySelector('#history-content').innerText.includes(n),name);
    await click(p,'#history-content [data-history-table]');
    await wait(p,()=>document.querySelector('#history-content').innerText.includes('Hand 1'));
    await click(p,'#history-close');
    console.log('Tournament complete:',info.standings.replace(/\s+/g,' '),'|',info.pots.replace(/\s+/g,' '));
  }
  // Play a second table without committing both stacks. The big blind must
  // have a free check, and a normal bet must use the exact slider amount.
  for (const p of pages) {
    await click(p,'#close-table-button');
    await wait(p,visible,'#table-list');
  }
  await create('Check and fold '+Date.now());
  const sb=await actor(), bb=sb===one?two:one;
  await verifyLeftmost(sb,'fold');
  await togglePre(bb,true);
  // A previously fetched view could be serialized later than the toggle.
  // Its public game version is identical, but its private selection is older.
  await ev(bb,()=>{
    const send=window.fetch;
    window.fetch=async function(url,opts) {
      const response=await send.apply(this,arguments);
      if(/\/tables\/[a-f0-9]+$/.test(String(url)) && (!opts?.method || opts.method==='GET')) {
        const data=await response.clone().json();
        const v=data.table;
        if(v?.viewer?.check_fold_selected) {
          window.fetch=send;
          v.viewer.check_fold_selected=false;
          v.viewer.check_fold_revision--;
          v.server_now+=2;
          window.oldTogglePollDelivered=true;
          return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
        }
      }
      return response;
    };
  });
  await wait(bb,()=>window.oldTogglePollDelivered);
  if(!await ev(bb,q=>document.querySelector(q)?.getAttribute('aria-pressed')==='true',pre)) throw Error('Late poll reversed the confirmed selection');
  await togglePre(bb,false);
  await click(sb,'[data-poker-action="call"]'); await wait(bb,visible,'[data-poker-action="check"]');
  await verifyLeftmost(bb,'check');
  if(await ev(bb,visible,'[data-poker-action="fold"]')) throw Error('Fold offered when checking is free');
  await click(bb,'[data-poker-action="check"]');
  await wait(bb,()=>document.querySelector('#street-label').textContent==='FLOP');
  const bettor=await actor(), folder=bettor===one?two:one;
  const range='#action-controls input[type=range]';
  await click(bettor,'[data-raise-preset][data-target="20"]');
  if(await ev(bettor,q=>Number(document.querySelector(q).value),range)!==20) throw Error('Half of the 40-chip pot must select 20');
  await input(bettor,range,37); await click(bettor,'[data-poker-action="raise_to"]');
  await wait(folder,s=>document.querySelector(s)?.innerText.includes('37'),'[data-poker-action="call"]');
  await click(folder,'[data-raise-preset][data-target="151"]');
  if(await ev(folder,q=>Number(document.querySelector(q).value),range)!==151) throw Error('Pot-size raise should call 37 then raise by the 114-chip pot');
  await click(folder,'[data-poker-action="fold"]');
  for(const p of pages) await wait(p,visible,'#hand-result .hand-result-recipient');
  console.log('Checked free, bet exactly 37 with slider, and folded facing a bet.');

  // The queued option executes server-side: the big blind checks when called,
  // then the other player folds to a flop bet without a second click.
  for (const p of pages) {await click(p,'#close-table-button'); await wait(p,visible,'#table-list');}
  await create('Advance action '+Date.now());
  const small=await actor(), big=small===one?two:one;
  // Hold the off-turn click in transit until the call makes the big blind the actor.
  await ev(big, () => {
    const original = window.fetch;
    window.fetch = async function(url, ...args) {
      if (String(url).endsWith('/preaction')) {
        window.fetch = original;
        await new Promise(resolve => {window.releaseCheckFold = resolve;});
      }
      return original.call(this,url,...args);
    };
  });
  await clickPre(big);
  await wait(big, () => typeof window.releaseCheckFold === 'function');
  await click(small,'[data-poker-action="call"]');
  await wait(big,visible,'[data-poker-action="check"]');
  await ev(big, () => window.releaseCheckFold());
  await wait(big,()=>document.querySelector('#street-label').textContent==='FLOP');
  await wait(big,visible,'[data-poker-action="raise_to"]');
  await togglePre(small,true);
  await click(big,'[data-poker-action="raise_to"]');
  for(const p of pages) await wait(p,visible,'#hand-result .hand-result-recipient');
  console.log('Check/Fold can be cleared, checks for free, and folds immediately to a bet.');

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
  await click(one,'#logout-button'); await wait(one,visible,'#login-name');
  await input(one,'#login-name','Robin'); await input(one,'#login-password','poker-test-password'); await submit(one,'#login-form');
  await wait(one,visible,'#history-button'); await click(one,'#history-button');
  await wait(one,n=>document.querySelector('#history-content').innerText.includes(n),name);
  console.log('Account sign-in restored private tournament history.');
  console.log('Only legal short raise selected; confirmation expired and no shove was submitted.');

}
