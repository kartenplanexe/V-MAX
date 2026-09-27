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
  const input=()=>dialog().getByRole('spinbutton',{name:'Радиус от старта, км',exact:true});
  const open=async()=>{
    await page.getByRole('complementary',{name:'Условия маршрута'}).getByRole('button',{name:'Изменить условия',exact:true}).click();
    await dialog().getByRole('heading',{name:'Старт и финиш',exact:true}).click();
  };
  const apply=async()=>{
    const response=page.waitForResponse(r=>r.url()===base+draftPath+'/plan');
    await dialog().getByRole('button',{name:'Применить и пересчитать',exact:true}).click();
    check((await response).status()===200,'Recalculation request failed');
    await dialog().waitFor({state:'hidden'}); return api(draftPath);
  };
  try {
    await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
    await page.setViewportSize({width:390,height:844}); await page.goto(base+'/?qa=result');
    await open(); check(await input().inputValue()==='5','Wrong initial radius');
    page.on('request',listener); await input().fill('12');
    await dialog().getByRole('button',{name:'Отменить правки',exact:true}).click();
    check(mutations.length===0&&same((await api(draftPath)).draft,baseline.draft),'Cancel changed server conditions');
    await open(); await input().fill('0.001');
    check(await input().evaluate(e=>e.validity.valid),'Form rejects the API lower bound of one meter');
    await input().fill('51');
    await dialog().getByRole('button',{name:'Применить и пересчитать',exact:true}).click();
    check(await input().evaluate(e=>e.validity.rangeOverflow),'Missing native radius validation');
    check(mutations.length===0,'Invalid radius caused a mutation');
    await input().fill('0.1');
    await page.screenshot({path:'output/playwright/search-radius-editor-mobile.png',animations:'disabled'});
    let changed=await apply();
    check(changed.result.status==='UNAVAILABLE'&&changed.result.search_scope.radius_meters===100,'Small radius was ignored');
    check(changed.result.days.every(day=>!day.visits.length),'Out-of-radius place included');
    check(same(changed.draft.days,baseline.draft.days)&&same(changed.draft.points,baseline.draft.points),'Radius edit changed another condition');
    check(mutations.length===3&&mutations[0].method==='PATCH'&&mutations[1].path.endsWith('/confirm')&&mutations[2].path.endsWith('/plan'),'Wrong mutation sequence');
    await page.getByRole('button',{name:'Изменить область поиска',exact:true}).waitFor();
    await page.screenshot({path:'output/playwright/search-radius-unavailable-mobile.png',fullPage:true,animations:'disabled'});
    observations.push({scenario:'cancel_native_validation_and_narrow_scope',status:'PASS',mutations:mutations.map(item=>item.method),radius_meters:100});

    await page.getByRole('button',{name:'Изменить область поиска',exact:true}).click();
    check(await input().isVisible(),'Scope action did not reveal the radius field');
    await input().fill('5'); mutations.length=0; changed=await apply();
    check(changed.result.status==='AVAILABLE'&&changed.result.search_scope.radius_meters===5000,'Explicit widening failed');
    check(changed.result.days[0].missing_activity_ids.length===0,'Walk or food disappeared');
    const saved=await api('/api/planning/saved/'+baseline.id);
    check(saved.conditions.shared.search_radius_meters===5000,'Saved radius was lost');
    await page.getByRole('button',{name:'Мои маршруты',exact:true}).click();
    await dialog().getByRole('button',{name:/Прогулка по городу.*Кафе.*текущий/}).click();
    await dialog().waitFor({state:'hidden'}); await page.reload();
    await page.getByRole('button',{name:'Радиус 5 км',exact:true}).click();
    check(await input().inputValue()==='5','Reopen lost chosen radius');
    await page.setViewportSize({width:1280,height:900}); await page.emulateMedia({colorScheme:'dark'});
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Wide editor overflows');
    await page.screenshot({path:'output/playwright/search-radius-editor-wide-dark.png',animations:'disabled'});
    await dialog().getByRole('button',{name:'Закрыть панель',exact:true}).click();
    observations.push({scenario:'explicit_widening_saved_reopen',status:'PASS',radius_meters:5000,coverage:'walk_and_food'});

    const created=await api('/api/planning/shares','POST',{draft_id:changed.id,base_revision:saved.revision,event_id:'qa-radius-share-'+Date.now(),include_private_points:false});
    const resolved=await api('/api/planning/shares/resolve','POST',{token:created.token});
    check(resolved.conditions.shared.search_radius_meters===5000&&!resolved.conditions.points.origin,'Sharing lost radius or disclosed private origin');
    check((await page.request.post(base+'/qa/clock/expire-drafts',{headers})).ok(),'QA clock unavailable');
    await page.reload(); await page.getByRole('heading',{name:'Вернёмся к вашему плану',exact:true}).waitFor();
    await page.getByText('Все сохранённые условия',{exact:true}).click();
    await page.getByText('Радиус от выбранного старта: 5 км',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Продолжить с этими условиями',exact:true}).click();
    await page.getByRole('button',{name:'Найти',exact:true}).click();
    await page.getByRole('button',{name:'Учебный город',exact:true}).click();
    await page.getByRole('complementary',{name:'Условия маршрута'}).waitFor();
    const restored=(await api('/api/planning/bootstrap')).view;
    check(restored.draft.shared.search_radius_meters===5000&&restored.result===null&&restored.confirmed_version===null,'Expiry restore lost radius or calculated implicitly');
    observations.push({scenario:'share_without_center_and_expiry_restore',status:'PASS'});
    return {status:'PASS',data_mode:'synthetic',observations};
  } finally {page.off('request',listener);}
}
