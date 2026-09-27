// Playwright CLI run-code; synthetic loopback harness only. Never use in MAX.
async page => {
  const base = 'http://127.0.0.1:4175';
  if (!page.url().startsWith(base + '/')) throw new Error('Open the synthetic loopback page first');
  const headers = { Origin: base, 'X-Max-Init-Data': 'qa-synthetic:result' };
  const check = (value, message) => { if (!value) throw new Error(message); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const mutations = [], observations = [];
  const listener = request => { if (request.url().startsWith(base + '/api/planning/') && request.method() !== 'GET')
    mutations.push({ method: request.method(), path: request.url().slice(base.length).replace(/drafts\/[^/]+/, 'drafts/:id') }); };
  async function api(path, method = 'GET', data) {
    const response = await page.request.fetch(base + path, { headers, method, ...(data ? { data } : {}), timeout: 60000 });
    check(response.ok(), `Synthetic setup/read failed: ${path.split('/').at(-1)} HTTP ${response.status()}`); return response.json();
  }
  const options = await api('/api/planning/manual/options', 'POST', { locality_token: 'qa-city' });
  const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  let baseline = await api('/api/planning/manual/requests', 'POST', { event_id: 'qa-activities-' + Date.now(), locality_token: 'qa-city',
    catalog_version: options.catalog_version, mobility: 'walking', days: [{ date: tomorrow.toISOString().slice(0, 10),
      start: '14:00', end: '19:00', ordered: true, activities: [{ kind: 'walk' }, { kind: 'place', category_ids: ['200'] }] }] });
  const draftPath = '/api/planning/drafts/' + baseline.id;
  baseline = await api(draftPath, 'PATCH', { base_version: baseline.version, event_id: 'qa-start-' + Date.now(), changes: [{ op: 'point', field: 'origin',
    point: { lat: 55.75, lon: 37.62, label: 'Учебная точка старта', source: 'user_map' } }] });
  baseline = await api(draftPath + '/confirm', 'POST', { base_version: baseline.version, event_id: 'qa-confirm-' + Date.now() });
  baseline = await api(draftPath + '/plan', 'POST', { base_version: baseline.version, event_id: 'qa-plan-' + Date.now() });

  const dialog=()=>page.getByRole('dialog');
  const open=async()=>{await page.getByRole('complementary',{name:'Условия маршрута'}).getByRole('button',{name:'Изменить условия',exact:true}).click(); await dialog().waitFor();};
  async function section(name){const heading=dialog().getByRole('heading',{name,exact:true}); if(!await heading.evaluate(node=>node.closest('details').open)) await heading.click();}
  async function geometry(){return page.evaluate(()=>{const rect=s=>document.querySelector(s)?.getBoundingClientRect(); const body=rect('.conditions-scroll'), footer=rect('.conditions-form > .sheet-actions'); return {overflow:document.documentElement.scrollWidth>innerWidth,first_stop_top:rect('.stop-card')?.top,first_stop_bottom:rect('.stop-card')?.bottom,height:document.documentElement.scrollHeight,footer_visible:!footer||footer.bottom<=innerHeight+1,footer_clear:!body||!footer||body.bottom<=footer.top+1};});}
  for(const theme of ['light','dark']) for(const width of [320,390,1280]){
    await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
    await page.setViewportSize({width,height:width===1280?900:844}); await page.goto(base+'/?qa=result');
    await page.getByRole('region',{name:'Результат расчёта'}).waitFor();
    await page.waitForFunction(t=>document.querySelector('.planner-page')?.dataset.theme===t,theme);
    const result=await geometry(); check(!result.overflow,'Result overflow '+theme+'/'+width);
    if(width===390) check(result.first_stop_bottom<844,'First stop is below the first viewport');
    await page.screenshot({path:'output/playwright/stitch-result-'+theme+'-'+width+'.png',fullPage:true,animations:'disabled'});
    await open(); const panel=await geometry(); check(!panel.overflow&&panel.footer_visible&&panel.footer_clear,'Editor footer geometry '+theme+'/'+width);
    check(await dialog().locator('details[open]').count()===0,'Valid overview unexpectedly expanded');
    await page.screenshot({path:'output/playwright/stitch-conditions-'+theme+'-'+width+'.png',animations:'disabled'});
    await dialog().getByRole('button',{name:'Закрыть панель',exact:true}).click();
    check(await page.evaluate(()=>document.documentElement.style.overflow)!=='hidden','Page remained locked');
    observations.push({scenario:'layout_and_theme',theme,width,result,panel});
  }
  await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'}); await page.setViewportSize({width:390,height:844}); await page.reload();
  await open(); await section('Передвижение и участники');
  await dialog().getByRole('spinbutton',{name:'Участников',exact:true}).fill('2');
  await dialog().getByRole('combobox',{name:'Дети в группе',exact:true}).selectOption('children');
  const age=dialog().getByRole('spinbutton',{name:'Ребёнок 1, лет',exact:true});
  await section('Бюджет'); check(!await age.isVisible(),'Invalid age section was not collapsed');
  page.on('request',listener); await dialog().getByRole('button',{name:'Применить и пересчитать',exact:true}).click();
  await age.waitFor({state:'visible'});
  await page.waitForFunction(()=>document.activeElement?.getAttribute('type')==='number');
  check(await age.evaluate(e=>document.activeElement===e&&e.validity.valueMissing),'Native invalid field lost focus or validation');
  check(mutations.length===0,'Invalid collapsed field caused a mutation');
  await page.screenshot({path:'output/playwright/stitch-collapsed-validation.png',animations:'disabled'});
  await dialog().getByRole('button',{name:'Отменить правки',exact:true}).click(); page.off('request',listener);
  check(same((await api(draftPath)).draft,baseline.draft),'Cancelling invalid edit changed saved data');
  observations.push({scenario:'collapsed_invalid_field_revealed_and_focused',status:'PASS',mutations:0});
  await open(); const summary=dialog().locator('details[data-section="budget"] > summary'); await summary.focus(); await page.keyboard.press('Enter');
  check(await dialog().getByRole('combobox',{name:'Ограничение расходов',exact:true}).isVisible(),'Keyboard cannot open budget');
  await page.keyboard.press('Enter'); check(!await dialog().getByRole('combobox',{name:'Ограничение расходов',exact:true}).isVisible(),'Keyboard cannot close budget');
  await dialog().getByRole('button',{name:'Закрыть панель',exact:true}).click();
  await page.getByRole('button',{name:'14:00–19:00',exact:true}).click();
  check(await dialog().getByRole('textbox',{name:'Окончание дня 1',exact:true}).isVisible(),'Time chip did not open the time section');
  await dialog().getByRole('button',{name:'Закрыть панель',exact:true}).click();
  observations.push({scenario:'keyboard_sections_and_time_chip',status:'PASS'});
  await page.getByRole('button',{name:'Заменить',exact:true}).first().click();
  await dialog().getByRole('heading',{name:'Заменить остановку',exact:true}).waitFor();
  await page.screenshot({path:'output/playwright/stitch-alternative-mobile.png',animations:'disabled'});
  await dialog().getByRole('button',{name:'Закрыть панель',exact:true}).click();
  await page.getByRole('button',{name:'Поделиться',exact:true}).click();
  await dialog().getByRole('heading',{name:'Поделиться маршрутом',exact:true}).waitFor();
  await page.screenshot({path:'output/playwright/stitch-share-mobile.png',animations:'disabled'});
  await dialog().getByRole('button',{name:'Закрыть панель',exact:true}).click();
  await page.getByRole('button',{name:'Добавить событие',exact:true}).click();
  await dialog().getByRole('heading',{name:'События для вашего дня',exact:true}).waitFor();
  await page.screenshot({path:'output/playwright/stitch-events-mobile.png',animations:'disabled'});
  await dialog().getByRole('button',{name:'Закрыть панель',exact:true}).click();
  observations.push({scenario:'alternative_share_events_open',status:'PASS'});
  await page.goto(base+'/?qa=three');
  const days=page.getByRole('navigation',{name:'Дни маршрута',exact:true}); await days.waitFor();
  const response=await page.request.get(base+'/api/planning/bootstrap',{headers:{...headers,'X-Max-Init-Data':'qa-synthetic:three'}});
  check(response.ok(),'Three-day fixture failed'); const three=(await response.json()).view;
  check(three.result.days.length===3,'Three-day setup did not create three days');
  mutations.length=0; page.on('request',listener);
  for(const width of [390,1280]){
    await page.setViewportSize({width,height:width===1280?900:844});
    for(let index=0;index<3;index++){
      const button=days.getByRole('button').nth(index); await button.click();
      check(await button.getAttribute('aria-pressed')==='true','Selected day not marked');
      check(await page.locator('.stop-card').count()===three.result.days[index].visits.length,'Day switch changed visit coverage');
      check(await page.locator('.route-metrics dd').nth(0).textContent()==='6','Trip receipt must show all six stops, independent of the selected day');
      check(await page.locator('.route-metrics dd').nth(1).textContent()==='72 мин','Trip receipt must show travel across all three days');
      const label=new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',timeZone:'UTC'}).format(new Date(three.result.days[index].date+'T12:00:00Z'));
      check(await page.locator('.day-heading h3').textContent()===label,'Day heading did not follow the selected day');
      check(!(await geometry()).overflow,'Three-day horizontal overflow');
    }
    await page.screenshot({path:'output/playwright/stitch-three-'+width+'.png',fullPage:true,animations:'disabled'});
  }
  page.off('request',listener); check(mutations.length===0,'Switching days mutated the route');
  observations.push({scenario:'three_day_switching',status:'PASS',mutations:0});
  return {status:'PASS',data_mode:'synthetic',observations};
}
