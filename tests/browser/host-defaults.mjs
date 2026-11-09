import {openAdminFixture} from './admin-fixture.mjs';
export default async function hostDefaults([page],sleep) {
  const ev=(fn,...args)=>page.evaluate('('+fn.toString()+')(...'+JSON.stringify(args)+')');
  const assert=(value,message)=>{if(!value)throw Error(message);};
  async function wait(fn,...args){for(let i=0;i<160;i++){const result=await ev(fn,...args);if(result)return result;await sleep(100);}throw Error('Timed out '+fn+' '+await ev(()=>document.body.innerText.slice(-900)));}
  await openAdminFixture(page);
  await ev(()=>document.querySelector('#admin-tab-host-defaults').click());
  await wait(()=>document.querySelector('#admin-host-starting-stack')?.value==='1000');
  const values={'table-name':'Friday night','buy-in':'25','payout':'70, 30','starting-stack':'2500','small-blind':'25','big-blind':'50','level-minutes':'12.5','turn-seconds':'45'};
  await ev(values=>{for(const [key,value] of Object.entries(values))document.querySelector('#admin-host-'+key).value=value;document.querySelector('#admin-host-defaults-form').requestSubmit();},values);
  await wait(()=>document.querySelector('#admin-host-defaults-status').textContent.includes('Saved.'));
  for(const [w,h] of [[1366,768],[390,844],[320,568]]) {
    await page.resize(w,h);await sleep(100);
    assert(await ev(()=>document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('#admin-tabs button')].every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.height>=44;})),'Host defaults overflowed at '+w);
    await page.screenshot('host-defaults-'+w);
  }
  await page.reload();
  await openAdminFixture(page);
  await ev(()=>document.querySelector('#admin-tab-host-defaults').click());
  await wait(()=>document.querySelector('#admin-host-starting-stack')?.value==='2500');
  assert(await ev(values=>Object.entries(values).every(([key,value])=>document.querySelector('#admin-host-'+key).value===value),values),'Saved host defaults did not survive reload.');
  await ev(()=>document.querySelector('#admin-back-button').click());
  await wait(()=>document.querySelector('#create-game-tab')?.offsetWidth);
  await ev(()=>document.querySelector('#create-game-tab').click());
  await wait(()=>document.querySelector('#table-settings-dialog')?.open&&document.querySelector('#settings-starting-stack')?.value==='2500');
  const setup=await ev(()=>({name:document.querySelector('#settings-table-name').value,buyIn:document.querySelector('#settings-buy-in').value,stack:document.querySelector('#settings-starting-stack').value,small:document.querySelector('#settings-small-blind').value,big:document.querySelector('#settings-big-blind').value,minutes:document.querySelector('#settings-level-minutes').value,seconds:document.querySelector('#settings-turn-seconds').value,places:document.querySelector('#payout-place-count').value,payout:document.querySelector('#settings-payout').value}));
  assert(setup.name==='Friday night'&&setup.buyIn==='25'&&setup.stack==='2500'&&setup.small==='25'&&setup.big==='50'&&setup.minutes==='12.5'&&setup.seconds==='45'&&setup.places==='2'&&setup.payout.replace(/\s/g,'')==='70,30','New host setup did not use saved defaults: '+JSON.stringify(setup));
  await page.screenshot('new-game-host-defaults');
  await ev(()=>{document.querySelector('#settings-starting-stack').value='5000';document.querySelector('#settings-starting-stack').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#table-settings-form').requestSubmit();});
  await wait(()=>document.querySelector('#notice')?.textContent.includes('Table settings saved.'));
  console.log('Host defaults passed: admin save, reload persistence, phone layout, new-game setup, payout places and host override.');
}
