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
  const click = (p, s) => wait(p, q => {
    const n=document.querySelector(q);
    if (!n || n.disabled || n.hidden) return false;
    const menu=n.closest('details');
    if(menu && n.tagName !== 'SUMMARY' && !menu.open) menu.open=true;
    if(!n.offsetWidth) return false;
    n.click(); return true;
  }, s);
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
  const origin = await one.evaluate('location.origin');
  async function adminRequest(path, session, data) {
    const headers = {Origin:origin,'Content-Type':'application/json'};
    if (session) Object.assign(headers, {Cookie:session.cookie,
      'X-SitNgo-Session':session.session_proof,'X-SitNgo-CSRF':session.csrf});
    const response = await fetch(origin+'/poker/api'+path,{method:'POST',headers,body:JSON.stringify(data)});
    const body = await response.json();
    if (!response.ok) throw Error(path+' '+JSON.stringify(body));
    return path==='/login' ? {...body,cookie:response.headers.get('set-cookie').split(';')[0]} : body;
  }
  const admin = await adminRequest('/login',null,{username:'admin',password:''});
  await adminRequest('/admin/config',admin,{runout_seconds:1.75,showdown_seconds:0,
    blind_announcement_seconds:0,elimination_announcement_seconds:0});
  async function create(name, extra = {}) {
    await click(one,'#create-game-tab');
    await wait(one,()=>document.querySelector('#table-settings-dialog')?.open);
    const values = {'#settings-table-name':name,'#settings-level-minutes':79,'#settings-turn-seconds':47};
    for (const [selector,value] of Object.entries(extra)) {
      if (!['#max-seats','#payout'].includes(selector)) values[selector.replace('#','#settings-')] = value;
    }
    for (const [selector,value] of Object.entries(values)) await input(one,selector,value);
    await input(one,'#payout-place-count',2);
    await input(one,'#payout-sliders input[type=range]',extra['#payout'] ? Number(extra['#payout'].split(',')[0]) : 70);
    await click(one,'#save-settings-button');
    await wait(one,n=>document.querySelector('#view-table-name')?.textContent===n &&
      document.querySelector('#save-settings-button').disabled,name);
    await ev(one,()=>{const dialog=document.querySelector('#table-settings-dialog');if(dialog?.open)dialog.close();});
    await wait(two,n=>{const e=[...document.querySelectorAll('[data-open-table]')].find(e=>e.innerText.includes(n)); if(!e) return false; e.click(); return true;},name);
    await click(two,'[data-take-seat="1"]');
    await wait(one,()=>!document.querySelector('#start-button').disabled);
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
      const odds=[...document.querySelectorAll('.seat-equity:not(.is-empty)')].filter(e=>e.offsetWidth).map(e=>[e.dataset.playerId,e.innerText]);
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
    if(await ev(other,visible,'.seat-equity:not(.is-empty)')) throw Error('Odds appeared while action still pending');
    const topSeatSnapshot = async p => ev(p, () => {
      const bounds = node => {
        const r = node.getBoundingClientRect();
        return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,
          centerX:r.left+r.width/2,centerY:r.top+r.height/2};
      };
      const seat = document.querySelector('#seat-grid .seat-card:not(.is-me)[data-player-id]');
      const cards = seat?.querySelector('.seat-cards');
      const felt = document.querySelector('#felt');
      const miniCards = [...(cards?.querySelectorAll('.mini-card') || [])].map(node => {
        const box = bounds(node), style = getComputedStyle(node);
        return {...box, visible:style.display !== 'none' && style.visibility !== 'hidden' &&
          box.width > 0 && box.height > 0, back:node.classList.contains('back')};
      });
      return seat && cards && felt ? {seat:bounds(seat),cards:bounds(cards),miniCards,felt:bounds(felt)} : null;
    });
    const beforeRunout = [];
    for (let index = 0; index < pages.length; index++) {
      await pages[index].resize(index === 0 ? 320 : 1280, index === 0 ? 568 : 800);
      await sleep(100);
      beforeRunout[index] = await topSeatSnapshot(pages[index]);
      if (!beforeRunout[index]) throw Error('Could not measure the heads-up top opponent before all-in');
      if (beforeRunout[index].miniCards.length !== 2 ||
          !beforeRunout[index].miniCards.every(card => card.visible && card.back)) {
        throw Error('Opponent must show two visible card backs before all-in at ' +
          (index === 0 ? '320px' : '1280px') + ': ' + JSON.stringify(beforeRunout[index].miniCards));
      }
      await pages[index].screenshot('top-opponent-before-' + (index === 0 ? 'mobile' : 'desktop'));
    }
    await click(other,'[data-poker-action="call"]');
    for(const p of pages) await wait(p,visible,'.seat-equity:not(.is-empty)');
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      await page.screenshot('top-opponent-all-in-' + (index === 0 ? 'mobile' : 'desktop'));
      const after = await ev(page, () => {
        const bounds = node => {
          const r = node.getBoundingClientRect();
          return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,
            centerX:r.left+r.width/2,centerY:r.top+r.height/2};
        };
        const seat = document.querySelector('#seat-grid .seat-card:not(.is-me)[data-player-id]');
        const cards = seat?.querySelector('.seat-cards');
        const odds = seat?.querySelector('.seat-equity:not(.is-empty)');
        const felt = document.querySelector('#felt');
        const miniCards = [...(cards?.querySelectorAll('.mini-card') || [])].map(node => {
          const box = bounds(node), style = getComputedStyle(node);
          return {...box,visible:style.display !== 'none' && style.visibility !== 'hidden' &&
            box.width > 0 && box.height > 0,back:node.classList.contains('back')};
        });
        const blockers = ['#blind-strip','#board-caption','#board-cards','#pot-display','#street-label']
          .map(selector => document.querySelector(selector))
          .filter(node => node && !node.hidden && node.offsetWidth)
          .map(bounds);
        const overlaps = (a,b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const seatBox = seat && bounds(seat);
        const cardBox = cards && bounds(cards);
        const oddsBox = odds && bounds(odds);
        const feltBox = felt && bounds(felt);
        const markerBoxes = Array.from(document.querySelectorAll('.dealer-marker,.seat-action,.seat-wager'))
          .filter(node => !node.hidden && node.offsetWidth)
          .map(bounds);
        return seatBox && cardBox && oddsBox && feltBox ? {
          seat:seatBox,cards:cardBox,miniCards,odds:oddsBox,felt:feltBox,
          blockerOverlaps:blockers.filter(box => overlaps(seatBox,box)).length,
          oddsBlockerOverlaps:blockers.filter(box => overlaps(oddsBox,box)).length,
          oddsMarkerOverlaps:markerBoxes.filter(box => overlaps(oddsBox,box)).length,
          oddsInsideFelt:oddsBox.left >= feltBox.left-1 && oddsBox.right <= feltBox.right+1 &&
            oddsBox.top >= feltBox.top-1 && oddsBox.bottom <= feltBox.bottom+1
        } : null;
      });
      const before = beforeRunout[index];
      if (!after) throw Error('Could not measure the heads-up top opponent during all-in runout');
      const shiftX = Math.abs(after.seat.centerX-before.seat.centerX);
      const shiftY = Math.abs(after.seat.centerY-before.seat.centerY);
      const cardsShiftX = Math.abs(after.cards.centerX-before.cards.centerX);
      const cardsShiftY = Math.abs(after.cards.centerY-before.cards.centerY);
      const internalCardsValid = after.miniCards.length === 2 && after.miniCards.every(card => card.visible && !card.back);
      const internalCardShifts = after.miniCards.map((card, cardIndex) => ({
        x:Math.abs(card.centerX-before.miniCards[cardIndex].centerX),
        y:Math.abs(card.centerY-before.miniCards[cardIndex].centerY)
      }));
      const internalCardsShifted = internalCardShifts.some(shift => shift.x > 1 || shift.y > 1);
      console.log('Heads-up all-in layout at ' + (index === 0 ? '320px' : '1280px') +
        ': horizontal seat/card shifts ' + shiftX.toFixed(1) + '/' + cardsShiftX.toFixed(1) +
        'px; vertical shifts ' + shiftY.toFixed(1) + '/' + cardsShiftY.toFixed(1) + 'px');
      if (shiftX > 1 || shiftY > 1 || cardsShiftX > 1 || cardsShiftY > 1 || !internalCardsValid || internalCardsShifted) {
        throw Error('Top opponent cards moved when all-in odds appeared at ' +
          (index === 0 ? '320px' : '1280px') + ': ' +
          JSON.stringify({shiftX,shiftY,cardsShiftX,cardsShiftY,internalCardShifts,before:before.seat,after:after.seat}));
      }
      if (after.blockerOverlaps || after.oddsBlockerOverlaps || after.oddsMarkerOverlaps || !after.oddsInsideFelt) {
        throw Error('Top opponent or all-in odds overlap table content at ' +
          (index === 0 ? '320px' : '1280px') + ': ' + JSON.stringify(after));
      }
    }
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
  await click(one,'#table-logout-button'); await wait(one,visible,'#login-name');
  await input(one,'#login-name','Robin'); await input(one,'#login-password','poker-test-password'); await submit(one,'#login-form');
  await wait(one,visible,'#app-panel'); await click(one,'#history-button');
  await wait(one,n=>document.querySelector('#history-content').innerText.includes(n),name);
  console.log('Account sign-in restored private tournament history.');
  console.log('Short-stack all-in raise and call each made exactly one immediate request.');

}
