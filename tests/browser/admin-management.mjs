import {openAdminFixture} from './admin-fixture.mjs';
import {seedAvatar} from './avatar-fixture.mjs';
export default async function adminManagement([page,playerPage],sleep,roomPassword){
  const ev=(fn,...args)=>page.evaluate('('+fn.toString()+')(...'+JSON.stringify(args)+')');
  const assert=(ok,message)=>{if(!ok)throw Error(message);};
  async function wait(fn,...args){for(let i=0;i<200;i++){const value=await ev(fn,...args);if(value)return value;await sleep(100);}throw Error('Timed out '+fn+' '+await ev(()=>document.body.innerText.slice(-700)));}
  async function click(selector){await wait(query=>{const node=document.querySelector(query);if(!node?.offsetWidth||node.disabled)return false;node.click();return true;},selector);}
  const origin=await page.evaluate('location.origin');
  async function raw(path,user,body){const response=await fetch(origin+'/poker/api'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(user?{Cookie:user.cookie,'X-SitNgo-Session':user.session_proof,'X-SitNgo-CSRF':user.csrf}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,requestId:response.headers.get('X-Request-ID'),...await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  async function request(path,user,body){const data=await raw(path,user,body);if(data.status>=400)throw Error(path+' '+JSON.stringify(data));return data.table||data;}
  const admin=await request('/login',null,{username:'admin',password:'test-admin-password'});
  const users=[];
  for(const username of ['deletecandidate','gamekeeper']){const user=await request('/register',null,{username,password:'test-account-password',room_password:roomPassword});await seedAvatar(request,user);users.push(user);}
  const [target,keeper]=users;
  async function game(name,bot,ended){const view=await request('/tables',keeper,{name,starting_stack:1000,small_blind:5,big_blind:10,level_minutes:10});if(bot)await request('/tables/'+view.id+'/bots',keeper,{seat_no:1});if(ended){const prompt=await request('/tables/'+view.id+'/end',keeper,{confirm:true});await request('/tables/'+view.id+'/end',keeper,{confirmation_token:prompt.confirmation_token});}return view.id;}
  const purgeId=await game('Past game with bots',true,true),keepId=await game('Past game with people',false,true),liveId=await game('Live game with bots',true,false);
  await openAdminFixture(page);
  assert(await ev(()=>[...document.querySelectorAll('#admin-tabs [role="tab"]')].map(node=>node.textContent).join('|')==='Table settings|Users|Profile images|Past games|Host defaults|Logs'&&!document.querySelector('#admin-tables-details')),'Admin tabs are incorrect or obsolete tools remain.');
  const loggedError=await raw('/admin/history/'+'0'.repeat(32),admin);
  assert(loggedError.status===404&&loggedError.requestId,'Expected a traceable missing-game error.');
  await click('#admin-tab-logs');
  await ev(ref=>{document.querySelector('#admin-logs-reference').value=ref.slice(0,8);document.querySelector('#admin-logs-form').requestSubmit();},loggedError.requestId);
  await wait(ref=>document.querySelectorAll('#admin-logs-list details').length===1&&document.querySelector('#admin-logs-list').textContent.includes(ref),loggedError.requestId);
  await ev(()=>document.querySelector('#admin-logs-list details').open=true);
  for(const [w,h] of [[1366,768],[320,568]]){
    await page.resize(w,h);await sleep(150);
    assert(await ev(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('#admin-logs-list pre').offsetHeight>0),'Logs overflow or details missing at '+w);
    await page.screenshot('admin-logs-'+w);
  }
  await ev(()=>{document.querySelector('#admin-logs-reference').value='0'.repeat(32);document.querySelector('#admin-logs-form').requestSubmit();});
  await wait(()=>document.querySelector('#admin-logs-status').textContent==='No matching log entries in the retained logs.'&&document.querySelector('#admin-logs-list').children.length===0);
  await ev(()=>{document.querySelector('#admin-tab-settings').focus();document.querySelector('#admin-tab-settings').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));});
  await wait(()=>document.querySelector('#admin-tab-users').getAttribute('aria-selected')==='true');
  for(const [w,h] of [[1366,768],[390,844],[320,568]]){
    await page.resize(w,h);await sleep(200);
    assert(await ev(()=>document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('#admin-panel [role="tabpanel"]')].filter(node=>!node.hidden).length===1&&[...document.querySelectorAll('#admin-tabs button')].every(node=>{const b=node.getBoundingClientRect();return b.width>=44&&b.height>=44&&b.left>=0&&b.right<=innerWidth+1;})),'Admin tabs or panels overflow the viewport at '+w);
  }
  await wait(()=>document.querySelectorAll('[data-account-role]').length===3);
  assert(await ev(id=>!document.querySelector('[data-account-delete="'+id+'"]'),admin.player.id),'Admin has a delete-account button.');
  await ev(()=>{const filter=document.querySelector('#admin-accounts-filter');filter.value='deletecandidate';filter.dispatchEvent(new Event('input',{bubbles:true}));});
  assert(await ev(()=>document.querySelectorAll('#admin-accounts-list .admin-account').length===1),'User search failed.');
  await page.resize(390,844);await sleep(100);await page.screenshot('admin-users-phone');
  const deleteSelector='[data-account-delete="'+target.player.id+'"]';
  await click(deleteSelector);await wait(()=>document.querySelector('#admin-confirm-dialog').open);
  assert(await ev(()=>document.querySelector('#admin-confirm-title').textContent.includes('@deletecandidate')),'Delete confirmation does not identify the account.');
  await page.screenshot('admin-delete-confirm-phone');
  await click('#admin-confirm-cancel');
  assert((await raw('/me',target)).authenticated,'Cancel deleted the account.');
  await click(deleteSelector);await click('#admin-confirm-submit');
  await wait(()=>!document.querySelector('#admin-confirm-dialog').open&&document.querySelector('#admin-accounts-status').textContent==='Account deleted.');
  assert(!(await raw('/me',target)).authenticated&&(await raw('/login',null,{username:'deletecandidate',password:'test-account-password'})).status===401,'Deleted account retained sign-in access.');
  await click('#admin-tab-images');await wait(()=>document.querySelector('#admin-avatar-presets').offsetWidth&&document.querySelectorAll('#admin-avatar-catalog-list img').length>0);
  await page.screenshot('admin-images-phone');
  await click('#admin-tab-settings');await wait(()=>Boolean(document.querySelector('#admin-showdown-seconds').offsetWidth));
  await page.resize(1366,768);await sleep(100);await page.screenshot('admin-settings-desktop');
  await click('#admin-tab-games');await wait(()=>document.querySelectorAll('#admin-history-list [data-admin-history-id]').length===2);
  await click('#admin-purge-bots');await wait(()=>document.querySelector('#admin-confirm-dialog').open);
  assert(await ev(()=>document.querySelector('#admin-confirm-title').textContent==='Purge 1 game with bots?'),'Purge count includes active or human-only games.');
  await click('#admin-confirm-cancel');
  assert((await raw('/admin/history/'+purgeId,admin)).status===200,'Cancel purged a past game.');
  await click('#admin-purge-bots');await page.screenshot('admin-purge-confirm-desktop');await click('#admin-confirm-submit');
  await wait(()=>document.querySelector('#admin-games-status').textContent==='1 game purged.');
  assert((await raw('/admin/history/'+purgeId,admin)).status===404&&(await raw('/admin/history/'+keepId,admin)).status===200&&(await raw('/tables/'+liveId,keeper)).table.status==='lobby','Purge removed the wrong games.');
  await click('#admin-purge-bots');await wait(()=>document.querySelector('#admin-games-status').textContent==='No past games with bots to purge.');
  await page.screenshot('admin-past-games-desktop');
  console.log('Admin management passed: six tabs, keyboard/mobile layout, account search and confirmed deletion, admin protection, revoked access, count-confirmed bot purge and active/human game preservation.');
}
