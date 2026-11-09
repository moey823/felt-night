import {seedAvatar} from './avatar-fixture.mjs';
export default async function wholeDollarPayouts([page],sleep,roomPassword){
  const ev=(fn,...args)=>page.evaluate('('+fn.toString()+')(...'+JSON.stringify(args)+')');
  const assert=(ok,message)=>{if(!ok)throw Error(message);};
  async function wait(fn,...args){for(let i=0;i<250;i++){const value=await ev(fn,...args);if(value)return value;await sleep(100);}throw Error('Timed out '+fn+' '+await ev(()=>document.body.innerText.slice(-800)));}
  const origin=await page.evaluate('location.origin');
  async function request(path,user,body){const response=await fetch(origin+'/poker/api'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(user?{Cookie:user.cookie,'X-SitNgo-Session':user.session_proof,'X-SitNgo-CSRF':user.csrf}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const data={...await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};if(!response.ok)throw Error(path+' '+JSON.stringify(data));return data.table||data;}
  const admin=await request('/login',null,{username:'admin',password:'test-admin-password'});
  await request('/admin/config',admin,{runout_seconds:1,showdown_seconds:2,elimination_announcement_seconds:0,blind_announcement_seconds:0});
  const users=[];
  for(const username of ['dollarone','dollartwo']){const user=await request('/register',null,{username,password:'test-account-password',room_password:roomPassword});await seedAvatar(request,user);users.push(user);}
  const game=await request('/tables',users[0],{name:'Whole dollar payouts',buy_in:13,starting_stack:1000,small_blind:5,big_blind:10,level_minutes:10,turn_seconds:3600,payout_percentages:[75,25]});
  const path='/tables/'+game.id;
  await request(path+'/join',users[1],{});
  let view=await request(path+'/start',users[0],{});
  await ev(id=>location.assign('/poker/table?table='+id),game.id);
  await wait(()=>Boolean(document.querySelector('#login-name')?.offsetWidth));
  await ev(()=>{document.querySelector('#login-name').value='dollarone';document.querySelector('#login-password').value='test-account-password';document.querySelector('#login-form').requestSubmit();});
  await wait(()=>!document.querySelector('#table-view')?.hidden);
  for(let hand=0;hand<8&&view.status!=='completed';hand++){
    const originalHand=view.hand_no;
    let actor=users.find(user=>user.player.id===view.actor_id);
    view=await request(path+'/action',actor,{action:'all_in',expected_hand:view.hand_no,expected_turn_version:view.turn_version});
    if(view.actor_id){actor=users.find(user=>user.player.id===view.actor_id);view=await request(path+'/action',actor,{action:'call',expected_hand:view.hand_no,expected_turn_version:view.turn_version});}
    for(let attempt=0;attempt<200;attempt++){
      view=await request(path,users[0]);
      assert(!view.viewer?.rebuy_offer&&!(view.rebuy_waiting||[]).length,'Heads-up game exposed a rebuy offer.');
      if(view.status==='completed'||view.hand_no>originalHand&&view.actor_id)break;
      await sleep(100);
    }
  }
  assert(view.status==='completed','Heads-up game did not finish.');
  assert(view.prize_pool_cents===2600&&view.buy_in_count===2,'Prize pool differs from total buy-ins.');
  assert(view.results.reduce((sum,row)=>sum+row.award_cents,0)===2600&&view.results.map(row=>row.award_cents).sort((a,b)=>a-b).join(',')==='600,2000','Whole-dollar awards do not conserve the $26 pool: '+JSON.stringify(view.results));
  await wait(()=>Boolean(document.querySelector('#results-list')?.offsetWidth)&&document.querySelector('#results-list').textContent.includes('$20')&&document.querySelector('#results-list').textContent.includes('$6'));
  assert(await ev(()=>!document.querySelector('#rebuy-offer-dialog')?.open&&!/\$[\d,]+\.\d\d/.test(document.body.innerText)),'A cents amount or heads-up rebuy dialog remains visible.');
  for(const [w,h] of [[1366,768],[390,844]]){await page.resize(w,h);await sleep(150);await page.screenshot('whole-dollar-results-'+w+'x'+h);}
  const saved=await request('/history/'+game.id,users[0]);
  assert(saved.tournament.results.reduce((sum,row)=>sum+row.award_cents,0)===2600&&saved.tournament.results.every(row=>row.award_cents%100===0),'Saved history contains fractional awards or an incorrect payout total.');
  assert(!/\d+\.\d\d/.test(saved.tournament.summary_text),'Summary text includes cents.');
  console.log('Whole-dollar payouts passed: $26 of buy-ins pays $20/$6, no heads-up rebuys, no cents in results/history, and desktop/phone result views.');
}
