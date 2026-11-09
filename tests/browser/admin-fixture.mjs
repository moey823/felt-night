// Sign in with the isolated fixture account, then explicitly open administration.
export async function openAdminFixture(page) {
  await page.evaluate('window.fixtureAdminLoginStarted=false');
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let i=0;i<200;i++) {
    const ready=await page.evaluate(`(() => {
      if(document.querySelector('#admin-panel')?.offsetWidth)return true;
      const button=document.querySelector('#admin-button');
      if(button&&!button.hidden&&button.offsetWidth){button.click();return false;}
      const login=document.querySelector('#login-name');
      if(login?.offsetWidth&&!window.fixtureAdminLoginStarted){
        window.fixtureAdminLoginStarted=true;
        login.value='admin';login.dispatchEvent(new Event('input',{bubbles:true}));
        document.querySelector('#login-password').value='test-admin-password';
        document.querySelector('#login-form').requestSubmit();
      }
      return false;
    })()`);
    if(ready)return;
    await sleep(100);
  }
  throw Error('Fixture admin screen did not open');
}
