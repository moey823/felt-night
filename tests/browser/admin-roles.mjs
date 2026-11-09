import {seedAvatar} from './avatar-fixture.mjs';
export default async function adminRoles([one,two],sleep,roomPassword) {
  const ev=(page,fn,...args)=>page.evaluate('('+fn.toString()+')(...'+JSON.stringify(args)+')');
  const assert=(ok,message)=>{if(!ok)throw Error(message);};
  async function wait(page,fn,...args){for(let i=0;i<300;i++){const value=await ev(page,fn,...args);if(value)return value;await sleep(100);}throw Error('Timed out: '+fn+' '+await ev(page,()=>document.body.innerText.slice(-700)));}
  async function click(page,selector){await wait(page,query=>{const node=document.querySelector(query);if(!node)return false;const menu=node.closest('details');if(menu)menu.open=true;if(!node.offsetWidth||node.disabled)return false;node.click();return true;},selector);}
  const origin=await one.evaluate('location.origin');
  async function api(path,user,body){const response=await fetch(origin+'/poker/api'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(user?{Cookie:user.cookie,'X-SitNgo-Session':user.session_proof,'X-SitNgo-CSRF':user.csrf}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();return {status:response.status,...data,cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  async function request(path,user,body){const data=await api(path,user,body);if(data.status>=400)throw Error(path+' '+JSON.stringify(data));return data.table||data;}
  const users=[];
  for(const username of ['firstowner','secondplayer']){
    const user=await request('/register',null,{username,password:'test-account-password',room_password:roomPassword});
    await seedAvatar(request,user);users.push(user);
  }
  const [owner,second]=users;
  assert(owner.player.is_admin&&!second.player.is_admin,'First account bootstrap assigned incorrect roles.');
  assert((await api('/login',null,{username:'firstowner',password:''})).status===401,'Blank-password admin login succeeded.');
  async function signIn(page,user){await wait(page,()=>Boolean(document.querySelector('#login-name')?.offsetWidth));await ev(page,username=>{document.querySelector('#login-name').value=username;document.querySelector('#login-name').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-password').value='test-account-password';document.querySelector('#login-form').requestSubmit();},user.player.username);await wait(page,()=>!document.querySelector('#app-panel')?.hidden);}
  await signIn(one,owner);await signIn(two,second);
  assert(await ev(one,()=>document.querySelector('#admin-panel').hidden&&!document.querySelector('#admin-button').hidden),'Admin did not enter the normal player app.');
  assert(await ev(two,()=>document.querySelector('#admin-button').hidden),'Non-admin sees Admin button.');
  await click(one,'#admin-button');
  await wait(one,()=>!document.querySelector('#admin-panel').hidden&&document.querySelectorAll('[data-account-role]').length===2);
  assert(await ev(one,id=>document.querySelector('[data-account-role="'+id+'"]').disabled,owner.player.id),'Last admin can remove itself in the UI.');
  await click(one,'[data-account-role="'+second.player.id+'"]');
  await wait(two,()=>!document.querySelector('#admin-button').hidden);
  await click(two,'#admin-button');
  await wait(two,()=>!document.querySelector('#admin-panel').hidden&&document.querySelectorAll('[data-account-role]').length===2);
  await ev(two,()=>{document.querySelector('#admin-showdown-seconds').value='7';document.querySelector('#admin-config-form').requestSubmit();});
  await wait(two,()=>document.querySelector('#admin-config-status').textContent.includes('Saved.'));
  assert(Number((await request('/admin/config',second)).config.showdown_seconds)===7,'Promoted admin could not save settings.');
  await click(one,'[data-account-role="'+owner.player.id+'"]');
  await wait(one,()=>document.querySelector('#admin-panel').hidden&&document.querySelector('#admin-button').hidden&&!document.querySelector('#app-panel').hidden);
  assert((await api('/admin/config',owner,{showdown_seconds:9})).status===403,'Demoted session retained admin access.');
  assert((await request('/me',owner)).authenticated,'Self-demotion logged out the player.');
  assert((await api('/admin/accounts/'+second.player.id+'/role',second,{is_admin:false})).status===409,'Last-admin API protection failed.');
  await click(two,'#admin-accounts-refresh');
  await wait(two,id=>document.querySelector('[data-account-role="'+id+'"]').disabled,second.player.id);
  await two.resize(390,844);await sleep(200);
  assert(await ev(two,()=>document.documentElement.scrollWidth<=innerWidth+1&&
    [...document.querySelectorAll('#identity button,#admin-panel button')].filter(node=>node.offsetWidth).every(node=>{
      const box=node.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth+1;
    })), 'Admin controls are clipped on a phone.');
  await two.screenshot('admin-roles-phone');
  await two.resize(1366,768);await sleep(200);await two.screenshot('admin-roles-desktop');
  await click(two,'[data-account-role="'+owner.player.id+'"]');
  await wait(one,()=>!document.querySelector('#admin-button').hidden);
  await request('/profile',owner,{display_name:'First owner'});
  const game=await request('/tables',owner,{name:'Admin can play',starting_stack:1000,small_blind:5,big_blind:10,level_minutes:10});
  await request('/tables/'+game.id+'/join',second,{});
  await ev(one,id=>location.assign('/poker/table?table='+id),game.id);
  await wait(one,()=>!document.querySelector('#table-view')?.hidden&&Boolean(document.querySelector('#hero-seat')));
  await click(one,'#table-admin-button');
  await wait(one,()=>!document.querySelector('#admin-panel').hidden);
  await click(one,'#admin-back-button');
  await wait(one,()=>!document.querySelector('#table-view')?.hidden&&Boolean(document.querySelector('#hero-seat')));
  const started=await request('/tables/'+game.id+'/start',owner,{});
  const actor=users.find(user=>user.player.id===started.actor_id);
  assert(actor,'Admin-role game did not deal an actor.');
  const acted=await request('/tables/'+game.id+'/action',actor,{action:'call',expected_hand:started.hand_no,expected_turn_version:started.turn_version});
  assert(acted.turn_version>started.turn_version,'Admin-role player could not act.');
  await one.screenshot('admin-role-playing');
  console.log('Admin roles passed: first-account bootstrap, normal player app, grant/remove roles, live session changes, last-admin protection, settings, profiles, table navigation and gameplay.');
}
