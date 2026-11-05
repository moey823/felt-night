// Two isolated browsers play on a disposable development server.
// See README for the headless test command.
export default async function game([one, two], sleep, roomPassword) {
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
    await input(p,'#login-password','poker-test-password'); await input(p,'#room-password',roomPassword); await submit(p,'#login-form'); await wait(p, visible, '#app-panel');
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
      const buttons=[...document.querySelectorAll('#action-controls [data-poker-action]')].filter(n=>n.offsetWidth&&!n.disabled);
      const first=buttons.find(n=>n.dataset.pokerAction===wanted);
      return first && buttons.every(n=>first.getBoundingClientRect().left <= n.getBoundingClientRect().left+1);
    },action);
    if(!pass) throw Error(action+' must be the leftmost play action');
  }
  async function assertNoRetiredControls(p) {
    const present = await ev(p, () => Boolean(
      document.querySelector('[data-preaction], #preaction-help, #allInConfirm, [data-action="confirm-all-in"], #hand-result, .chip-flight-payout, .chip-flight-return')
    ));
    if (present) throw Error('A retired preaction, all-in confirmation, or live payout panel is present');
  }
  async function doubleClick(p, selector) {
    await wait(p, query => {
      const node = document.querySelector(query);
      if (!node?.offsetWidth || node.disabled) return false;
      node.click();
      node.click();
      return true;
    }, selector);
  }
  async function instrumentActionPosts(p) {
    await ev(p, () => {
      window.actionPostsQA = [];
      window.actionResponsesQA = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async function(input, init) {
        const url = typeof input === 'string' ? input : input.url;
        const isActionPost = url.includes('/poker/api/tables/') && /\/action(?:\?|$)/.test(url) &&
          String(init?.method || 'GET').toUpperCase() === 'POST';
        if (isActionPost) window.actionPostsQA.push(JSON.parse(init.body || '{}'));
        const response = await originalFetch(input, init);
        if (isActionPost) {
          let data = {};
          try { data = await response.clone().json(); } catch (_) {}
          window.actionResponsesQA.push({ok: response.ok, status: response.status, data});
        }
        return response;
      };
    });
  }
  async function submitOnce(p, selector, expectedAction) {
    const before = await ev(p, () => window.actionPostsQA.length);
    await doubleClick(p, selector);
    await wait(p, count => window.actionResponsesQA.length > count, before);
    const result = await ev(p, count => ({
      posts: window.actionPostsQA.slice(count),
      responses: window.actionResponsesQA.slice(count)
    }), before);
    if (result.posts.length !== 1 || result.responses.length !== 1) {
      throw Error('Expected one immediate action request; got ' + JSON.stringify(result));
    }
    if (result.posts[0].action !== expectedAction || !result.responses[0].ok ||
        !result.responses[0].data?.table) {
      throw Error('Unexpected action request or response: ' + JSON.stringify(result));
    }
    return {request: result.posts[0], table: result.responses[0].data.table};
  }
  async function handNumber(p) {
    return ev(p, () => {
      const match = document.querySelector('#hand-number')?.textContent.match(/HAND\s+(\d+)/);
      return match ? Number(match[1]) : 0;
    });
  }
  async function waitForHandEnd(p, previousNumber) {
    await wait(p, previous => {
      const status = document.querySelector('#view-status')?.textContent || '';
      const match = document.querySelector('#hand-number')?.textContent.match(/HAND\s+(\d+)/);
      const currentNumber = match ? Number(match[1]) : 0;
      return status.includes('Complete') || currentNumber > Number(previous);
    }, previousNumber);
  }
  async function assertServerAllIn(p, table, context) {
    const seat = await ev(p, view => {
      const id = String(view.viewer?.player_id || '');
      return view.seats?.find(candidate => String(candidate.id || candidate.player_id || '') === id) || null;
    }, table);
    if (!seat || Number(seat.stack) !== 0 || !(seat.all_in || seat.is_all_in)) {
      throw Error(context + ' did not leave the viewer all-in with zero chips: ' + JSON.stringify(seat));
    }
  }
  const name='Release check '+Date.now(); await create(name,{'#buy-in':13,'#payout':'75, 25','#max-seats':9});
  await one.resize(320,740); await two.resize(1280,800);
  for(const p of pages) {
    await assertNoRetiredControls(p);
    await ev(p,()=>{
    window.historyQA=[];
    window.setInterval(()=>{
      const board=[...document.querySelectorAll('#board-cards .playing-card')].filter(e=>e.innerText.trim()).length;
      const odds=[...document.querySelectorAll('.seat-equity')].filter(e=>e.offsetWidth).map(e=>[e.dataset.playerId,e.innerText]);
      const stamp=JSON.stringify([board,odds]); if(window.historyQA.at(-1)!==stamp) window.historyQA.push(stamp);
    },75);
    });
  }
  for(let attempt=0;attempt<4;attempt++) {
    const first=await actor(), other=first===one?two:one;
    const range='#action-controls input[type=range]';
    await wait(first,visible,range);
    if (attempt === 0) {
      await first.resize(320,740); await other.resize(1280,800);
      await ev(first,()=>document.querySelector('#action-panel').scrollIntoView({block:'center'}));
      await first.screenshot('mobile-actions');
      const layout=await ev(first,()=>{
        const bounds=n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
        const overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
        const inViewport=r=>r.width>0&&r.height>0&&r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1;
        const cards=[...document.querySelectorAll('.is-viewer-cards .mini-card')];
        const controls=[...document.querySelectorAll('#action-controls button, #action-controls input')];
        const dockNode=document.querySelector('#action-panel');
        const dock=dockNode.getBoundingClientRect();
        const felt=document.querySelector('#felt').getBoundingClientRect();
        const issues=[];
        if(dockNode.parentElement.id==='felt'||dock.top<felt.bottom-1) issues.push('action footer is not below and outside the felt');
        if(cards.length!==2) issues.push('missing hole cards');
        if(document.querySelectorAll('#seat-grid .seat-card').length!==2) issues.push('nine-seat lobby did not compact to two entrants');
        for(const n of cards) {
          const r=bounds(n);
          if(!inViewport(r)) issues.push(n.textContent+' is not fully visible');
          if(overlaps(r,dock)) issues.push(n.textContent+' overlaps the action panel');
        }
        for(const n of controls) {
          const r=bounds(n),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          if(!inViewport(r)||!hit||!(n===hit||n.contains(hit))) issues.push((n.textContent||n.id)+' obstructed or offscreen');
          if(cards.some(c=>overlaps(bounds(c),r))) issues.push((n.textContent||n.id)+' overlaps a hero card');
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
          const hero=box('.is-viewer-cards'),dock=box('#action-panel');
          const overlap=hero.left<dock.right&&hero.right>dock.left&&hero.top<dock.bottom&&hero.bottom>dock.top;
          const inViewport=r=>r.width>0&&r.height>0&&r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1;
          return {overlap,heroVisible:inViewport(hero),panelVisible:inViewport(dock),overflow:document.documentElement.scrollWidth>innerWidth};
        });
        await first.screenshot('actions-'+w);
        if(separation.overlap || !separation.heroVisible || !separation.panelVisible || separation.overflow) throw Error(w+'px hero cards and actions must be visible without overlap: '+JSON.stringify(separation));
      }
      await first.resize(320,740);
    }
    await click(first,'[data-raise-preset][data-target="50"]');
    if(await ev(first,q=>Number(document.querySelector(q).value),range)!==50) throw Error('2.5 BB did not select 50');
    const max=await ev(first,q=>Number(document.querySelector(q).max),range);
    if(!max || await ev(first,visible,'[data-poker-action="all_in"]')) throw Error('No unified raise range');
    await input(first,range,max);
    await click(first,'[data-poker-action="raise_to"]');
    await wait(other,()=>{const b=document.querySelector('[data-poker-action="call"]');return b?.offsetWidth&&!b.disabled;});
    if(await ev(other,visible,'.seat-equity')) throw Error('Odds appeared while action still pending');
    await click(other,'[data-poker-action="call"]');
    for(const p of pages) await wait(p,visible,'.seat-equity');
    await wait(one,()=>[...document.querySelectorAll('#board-cards .playing-card')].filter(e=>e.innerText.trim()).length===5);
    await wait(one,()=> {
      const street=document.querySelector('#street-label')?.textContent;
      const complete=document.querySelector('#view-status')?.textContent.includes('Complete');
      return complete || street==='RIVER' || street==='SHOWDOWN';
    });
    if(await ev(one,()=>document.querySelector('#hand-status-label').innerText.includes('COMPLETE'))) break;
    await wait(one,()=>document.querySelector('#action-panel').offsetWidth || document.querySelector('.seat-turn-clock')?.offsetWidth);
  }
  for(const p of pages) {
    await wait(p,visible,'#dismiss-results-button');
    const info=await ev(p,()=>({history:window.historyQA.map(JSON.parse), standings:document.querySelector('#results-panel').innerText, overflow:document.documentElement.scrollWidth>innerWidth+1}));
    if(info.history.some(([n])=>n===1 || n===2)) throw Error('Partial flop displayed');
    for(const n of [0,3,4]) if(!info.history.some(([count,odds])=>count===n && odds.length===2 && new Set(odds.map(o=>o[0])).size===2 && odds.every(o=>o[1].includes('%')))) throw Error('Missing live all-in odds before settlement at board size '+n+' '+JSON.stringify(info.history));
    if(/\bchips\b/i.test(info.standings) || !info.standings.includes('26 play credits awarded') || !info.standings.includes('20 credits') || !info.standings.includes('6 credits') || !info.standings.includes('Robin') || !info.standings.includes('Morgan') || info.overflow) throw Error(JSON.stringify(info));
    await assertNoRetiredControls(p);
    await click(p,'#dismiss-results-button'); await click(p,'#reopen-results-button'); await wait(p,visible,'#dismiss-results-button');
    await click(p,'#dismiss-results-button');
    await click(p,'#history-button');
    await wait(p,(n)=>document.querySelector('#history-content').innerText.includes(n),name);
    await click(p,'#history-content [data-history-table]');
    await wait(p,()=>document.querySelector('#history-content').innerText.includes('Hand 1'));
    await click(p,'#history-content details.history-entry > summary');
    await wait(p,()=>document.querySelector('#history-content').innerText.includes('Main pot'));
    const historyText=await ev(p,()=>document.querySelector('#history-content').innerText);
    if(!historyText.includes('Main pot') || !historyText.includes('Robin') || !historyText.includes('Morgan')) throw Error('Payout or hand record missing from tournament history: '+historyText);
    await click(p,'#history-close');
    console.log('Tournament complete:',info.standings.replace(/\s+/g,' '),'| history:',historyText.replace(/\s+/g,' ').slice(0,280));
  }
  // Play a second table without committing both stacks. The big blind must
  // have a free check, and a normal bet must use the exact slider amount.
  for (const p of pages) {
    await click(p,'#close-table-button');
    await wait(p,visible,'#table-list');
  }
  await create('Check and fold '+Date.now());
  const sb=await actor(), bb=sb===one?two:one;
  const bettingHand=await handNumber(sb);
  await assertNoRetiredControls(one); await assertNoRetiredControls(two);
  await verifyLeftmost(sb,'fold');
  await click(sb,'[data-poker-action="call"]');
  await wait(bb,()=>{const b=document.querySelector('[data-poker-action="check"]');return b?.offsetWidth&&!b.disabled;});
  await verifyLeftmost(bb,'check');
  if(!await ev(bb,q=>document.querySelector(q)?.disabled,'[data-poker-action="fold"]')) throw Error('Fold must be disabled when checking is free');
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
  await waitForHandEnd(sb,bettingHand);
  for(const p of pages) await assertNoRetiredControls(p);
  console.log('Checked free, bet exactly 37 with slider, and folded facing a bet.');

  // Heads-up action advances through explicit checks and folds.
  for (const p of pages) {await click(p,'#close-table-button'); await wait(p,visible,'#table-list');}
  await create('Advance action '+Date.now());
  const small=await actor(), big=small===one?two:one;
  const advanceHand=await handNumber(small);
  await assertNoRetiredControls(one); await assertNoRetiredControls(two);
  await click(small,'[data-poker-action="call"]');
  await wait(big,()=>{const b=document.querySelector('[data-poker-action="check"]');return b?.offsetWidth&&!b.disabled;});
  await click(big,'[data-poker-action="check"]');
  await wait(one,()=>document.querySelector('#street-label').textContent==='FLOP');
  const nextBettor=await actor(), nextFolder=nextBettor===one?two:one;
  await click(nextBettor,'[data-poker-action="raise_to"]');
  await wait(nextFolder,()=>{const b=document.querySelector('[data-poker-action="fold"]');return b?.offsetWidth&&!b.disabled;});
  await click(nextFolder,'[data-poker-action="fold"]');
  await waitForHandEnd(small,advanceHand);
  for(const p of pages) await assertNoRetiredControls(p);
  console.log('Heads-up action used manual checks and folds; no preaction controls rendered.');

  // A short stack can raise only to one legal value. Both the shove and
  // the all-in call submit on the first press and cannot be duplicated.
  for (const p of pages) {await click(p,'#close-table-button'); await wait(p,visible,'#table-list');}
  await create('Short raise '+Date.now(),{'#starting-stack':100,'#small-blind':40,'#big-blind':60,'#turn-seconds':5});
  const short=await actor(), bigBlind=short===one?two:one;
  const singleton=await ev(short,()=>{const r=document.querySelector('#raise-amount');return [r?.min,r?.max,r?.value];});
  const shortHand=await handNumber(short);
  if(singleton.join(',')!=='100,100,100')throw Error('Wrong short-shove bound '+singleton);
  for(const p of pages) await instrumentActionPosts(p);
  const shove=await submitOnce(short,'[data-poker-action="raise_to"]','raise');
  if(shove.request.amount!==100) throw Error('Short shove amount was not the legal 100-chip total: '+JSON.stringify(shove.request));
  await assertServerAllIn(short,shove.table,'Immediate all-in raise');
  if(await ev(short,()=>Boolean(document.querySelector('#allInConfirm, [data-action="confirm-all-in"]')))) throw Error('All-in confirmation UI still exists');
  await wait(bigBlind,()=>{const button=document.querySelector('#action-controls [data-poker-action="call"]');return button?.offsetWidth&&!button.disabled;});
  const call=await submitOnce(bigBlind,'[data-poker-action="call"]','call');
  await assertServerAllIn(bigBlind,call.table,'Immediate all-in call');
  for(const p of pages) await assertNoRetiredControls(p);
  await waitForHandEnd(short,shortHand);
  await click(one,'#logout-button'); await wait(one,visible,'#login-name');
  await input(one,'#login-name','Robin'); await input(one,'#login-password','poker-test-password'); await submit(one,'#login-form');
  await wait(one,visible,'#history-button'); await click(one,'#history-button');
  await wait(one,n=>document.querySelector('#history-content').innerText.includes(n),name);
  console.log('Account sign-in restored private tournament history.');
  console.log('Short-stack all-in raise and call each made exactly one immediate request.');

}
