// Nine authenticated players shove on the same hand. Verify their exposed seats fit.
export default async function crowded([page], sleep) {
 for(let i=0; i<100 && !await page.evaluate("!!document.querySelector('#login-form')"); i++) await sleep(100);
 const seatsCount = Number(process.env.QA_SEATS || 9);
 if(!Number.isInteger(seatsCount) || seatsCount<2 || seatsCount>9) throw Error("QA_SEATS must be 2–9");
 const origin = await page.evaluate('location.origin');
 const url = origin + '/poker/api';
 const req = async (path, session, data) => {
   const headers = {Origin:origin};
   if(session) Object.assign(headers,{Cookie:session.cookie,'X-SitNgo-Session':session.session_proof,'X-SitNgo-CSRF':session.csrf});
   if(data) headers['Content-Type']='application/json';
   const res=await fetch(url+path,{method:data?'POST':'GET',headers,body:data?JSON.stringify(data):undefined});
   const json=await res.json();
   if(!res.ok) throw Error(path+' '+JSON.stringify(json));
   return path==='/login'?{...json,cookie:res.headers.get('set-cookie').split(';')[0]}:json.table;
 };
 const sessions=[];
 for(let i=0;i<seatsCount;i++) sessions.push(await req('/login',null,{name:'Crowded '+i,password:'example-room-invite'}));
 const host=sessions[0];
 const table=await req('/tables',host,{name:'Nine-handed runout',max_seats:seatsCount,starting_stack:100,small_blind:10,big_blind:20,level_minutes:54,turn_seconds:60,runout_seconds:40});
 const path='/tables/'+table.id;
 for(let i=1;i<seatsCount;i++) await req(path+'/seat',sessions[i],{seat_no:i});
 let view=await req(path+'/start',host,{});
 while(view.actor_id) {
   const actor=sessions.find(s=>s.player.id===view.actor_id);
   view=await req(path+'/action',actor,{action:'all_in',expected_hand:view.hand_no,expected_turn_version:view.turn_version});
 }
 if(view.runout_odds?.length!==seatsCount) throw Error('All nine hands were not exposed');
 await page.evaluate("document.querySelector('#login-name').value='Rail';document.querySelector('#login-password').value='example-room-invite';document.querySelector('#login-form').requestSubmit()");
 for(let i=0;i<100;i++) {if(await page.evaluate("!!document.querySelector('[data-open-table]')")) break; await sleep(100);}
 await page.evaluate("document.querySelector('[data-open-table]').click()");
 for(let i=0;i<100;i++){if(await page.evaluate("document.querySelectorAll('.seat-equity').length") === seatsCount)break;await sleep(100);}
 for(const width of [320,390,768,1366]){
   await page.resize(width,850); await sleep(220);
   const info=await page.evaluate(`(()=>{
     const box=e=>e.getBoundingClientRect(), seats=[...document.querySelectorAll('.seat-card')], board=box(document.querySelector('#board-cards'));
     const area=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
     const errors=[];
     if(document.querySelectorAll('.seat-equity').length!==${seatsCount}) errors.push('missing odds');
     for(let i=0;i<seats.length;i++){
       let rect=box(seats[i]); if(area(board,rect)>5)errors.push('board overlaps '+i);
       for(let j=0;j<i;j++)if(area(rect,box(seats[j]))>5)errors.push('seat overlap '+i+' and '+j);
       const badge=seats[i].querySelector('.seat-equity'); if(!badge || !badge.offsetWidth)errors.push('invisible badge '+i);
       else {const bounds=box(badge);if(bounds.left<0||bounds.right>innerWidth+1)errors.push('badge clipped '+i);}
     }
     if(document.documentElement.scrollWidth>innerWidth+1)errors.push('page overflow');
     return errors;
   })()`);
   console.log(seatsCount,'exposed hands at',width,'px:',info);
   if(info.length) throw Error(info.join(', '));
 }
}
