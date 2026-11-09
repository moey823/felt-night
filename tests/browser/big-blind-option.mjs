import {seedAvatar} from './avatar-fixture.mjs';
export default async function bigBlindOption([page],sleep,roomPassword){
  const ev=(fn,...args)=>page.evaluate('('+fn.toString()+')(...'+JSON.stringify(args)+')');
  const assert=(ok,message)=>{if(!ok)throw Error(message);};
  async function wait(fn,...args){for(let i=0;i<200;i++){const result=await ev(fn,...args);if(result)return result;await sleep(100);}throw Error('Timed out '+fn+' '+await ev(()=>document.body.innerText.slice(-600)));}
  const origin=await page.evaluate('location.origin');
  async function raw(path,user,body){const response=await fetch(origin+'/poker/api'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(user?{Cookie:user.cookie,'X-SitNgo-Session':user.session_proof,'X-SitNgo-CSRF':user.csrf}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,...await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  async function request(path,user,body){const data=await raw(path,user,body);if(data.status>=400)throw Error(path+' '+JSON.stringify(data));return data.table||data;}
  const users=[];
  for(let i=0;i<3;i++){const user=await request('/register',null,{username:'blindplayer'+i,password:'test-account-password',room_password:roomPassword});await seedAvatar(request,user);users.push(user);}
  async function action(path,view,verb,amount){const user=users.find(row=>row.player.id===view.actor_id);return request(path+'/action',user,{action:verb,amount,expected_hand:view.hand_no,expected_turn_version:view.turn_version});}
  for(const count of [2,3]){
    if(count===3){await ev(()=>{document.querySelector('#table-menu').open=true;document.querySelector('#table-logout-button').click();});await wait(()=>Boolean(document.querySelector('#login-name')?.offsetWidth));}
    const game=await request('/tables',users[0],{name:'Big blind option '+count,starting_stack:1000,small_blind:5,big_blind:10,level_minutes:10,turn_seconds:3600});
    const path='/tables/'+game.id;
    for(const user of users.slice(1,count))await request(path+'/join',user,{});
    let view=await request(path+'/start',users[0],{});
    const bb=users.find(user=>user.player.id===view.big_blind_id);
    while(view.actor_id!==bb.player.id)view=await action(path,view,'call');
    const rejected=await raw(path+'/action',bb,{action:'fold',expected_hand:view.hand_no,expected_turn_version:view.turn_version});
    assert(rejected.status===400&&rejected.error?.code==='cannot_fold','Unraised big blind fold was accepted by the server.');
    await ev(id=>location.assign('/poker/table?table='+id),game.id);
    await wait(()=>Boolean(document.querySelector('#login-name')?.offsetWidth));
    await ev(username=>{document.querySelector('#login-name').value=username;document.querySelector('#login-password').value='test-account-password';document.querySelector('#login-form').requestSubmit();},bb.player.username);
    await wait(()=>document.querySelector('#action-controls')?.classList.contains('is-big-blind-option'));
    for(const [w,h] of [[1366,768],[390,844],[320,568],[667,375]]){
      await page.resize(w,h);await sleep(200);
      const controls=await ev(()=>{
        const root=document.querySelector('#action-controls'),fold=root.querySelector('[data-action-slot="fold"]');
        const buttons=[...root.querySelectorAll('[data-action-slot]')].filter(node=>node.offsetWidth);
        const rect=node=>{const box=node.getBoundingClientRect();return {left:box.left,right:box.right,width:box.width,height:box.height};};
        return {foldHidden:!fold.offsetWidth,foldDisabled:fold.disabled,buttons:buttons.map(node=>({slot:node.dataset.actionSlot,action:node.dataset.pokerAction,disabled:node.disabled,box:rect(node)})),root:rect(root)};
      });
      assert(controls.foldHidden&&controls.foldDisabled&&controls.buttons.length===2&&controls.buttons[0].action==='check'&&controls.buttons[1].action==='raise_to'&&controls.buttons.every(row=>!row.disabled&&row.box.width>=44&&row.box.height>=44&&row.box.left>=controls.root.left-1&&row.box.right<=controls.root.right+1),
        'Big blind controls must show only usable Check and Raise at '+w+'x'+h+': '+JSON.stringify(controls));
      assert(Math.abs(controls.buttons[0].box.width-controls.buttons[1].box.width)<1,'Check and Raise widths differ.');
      if(count===2)await page.screenshot('big-blind-option-'+w+'x'+h);
    }
    if(count===2){
      await ev(()=>document.querySelector('[data-action-slot="call"]').click());
      await wait(()=>document.querySelector('#street-label')?.textContent==='FLOP');
      assert(await ev(()=>!document.querySelector('#action-controls').classList.contains('is-big-blind-option')&&Boolean(document.querySelector('[data-action-slot="fold"]').offsetWidth)), 'Two-option layout leaked into the flop.');
    }else{
      await ev(()=>{const input=document.querySelector('#raise-amount');input.value='20';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action-slot="raise"]').click();});
      for(let i=0;i<100;i++){view=await request(path,bb);if(view.current_bet===20&&view.actor_id!==bb.player.id)break;await sleep(100);}
      assert(view.current_bet===20,'The big blind could not raise.');
      view=await action(path,view,'raise',40);
      while(view.actor_id!==bb.player.id)view=await action(path,view,'call');
      await wait(()=>{const fold=document.querySelector('[data-action-slot="fold"]');return fold?.offsetWidth&&!fold.disabled&&!document.querySelector('#action-controls').classList.contains('is-big-blind-option');});
      await ev(()=>document.querySelector('[data-action-slot="fold"]').click());
      await wait(()=>Boolean(document.querySelector('#hero-seat.is-folded')));
    }
  }
  console.log('Big blind option passed: heads-up/multiway Check or Raise only, direct fold rejection, four viewport layouts, postflop reset, legal raise and restored Fold facing a reraise.');
}
