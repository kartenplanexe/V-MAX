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
      start: '14:00', end: '19:00', ordered: true, activities: [{ kind: 'place', category_ids: ['100'] }, { kind: 'place', category_ids: ['200'] }] }] });
  const draftPath = '/api/planning/drafts/' + baseline.id;
  baseline = await api(draftPath, 'PATCH', { base_version: baseline.version, event_id: 'qa-start-' + Date.now(), changes: [{ op: 'point', field: 'origin',
    point: { lat: 55.75, lon: 37.62, label: 'Учебная точка старта', source: 'user_map' } }] });
  baseline = await api(draftPath + '/confirm', 'POST', { base_version: baseline.version, event_id: 'qa-confirm-' + Date.now() });
  baseline = await api(draftPath + '/plan', 'POST', { base_version: baseline.version, event_id: 'qa-plan-' + Date.now() });
  async function openEditor() {
    await page.getByRole('button', { name: 'Изменить условия', exact: true }).first().click();
    await page.getByRole('dialog').getByRole('heading', { name: 'Условия плана', exact: true }).waitFor();
    await openSection('Занятия и порядок');
  }
  async function openSection(name) {
    const heading = page.getByRole('dialog').getByRole('heading', { name, exact: true });
    if (!await heading.evaluate(node => node.closest('details').open)) await heading.click();
  }
  async function apply() {
    const response = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url() === base + draftPath);
    await page.getByRole('dialog').getByRole('button', { name: /Применить/ }).click();
    check((await response).status() === 200, 'Edit was rejected');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Мои маршруты', exact: true }).waitFor();
  }
  const editor = () => page.getByRole('dialog');
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/?qa=result'); await openEditor(); page.on('request', listener);
    // Failed category reads must leave both local edits and server state unchanged.
    await openSection('Дата и время');
    await editor().getByRole('textbox', { name: 'Окончание дня 1', exact: true }).fill('20:00');
    await openSection('Занятия и порядок');
    await page.route('**/activity-options', route => route.abort());
    await editor().getByRole('button', { name: 'Добавить занятие', exact: true }).click();
    await editor().getByRole('button', { name: 'Повторить загрузку занятий', exact: true }).waitFor();
    await openSection('Дата и время');
    check(await editor().getByRole('textbox', { name: 'Окончание дня 1', exact: true }).inputValue() === '20:00', 'Read failure discarded local time');
    await openSection('Занятия и порядок');
    await page.unroute('**/activity-options');
    await editor().getByRole('button', { name: 'Повторить загрузку занятий', exact: true }).click();
    await editor().getByRole('button', { name: 'Добавить прогулку', exact: true }).click();
    await editor().getByRole('button', { name: 'Убрать занятие «Музеи»', exact: true }).click();
    check(mutations.length === 0, 'Local edits made premature mutations');
    await editor().getByRole('button', { name: 'Отменить правки', exact: true }).click();
    check(same((await api(draftPath)).draft, baseline.draft), 'Cancel changed saved conditions');
    observations.push({ scenario: 'read_failure_retry_add_remove_cancel', status: 'PASS', premature_mutations: 0 });

    await openEditor();
    await editor().getByRole('button', { name: 'Убрать занятие «Музеи»', exact: true }).click();
    await editor().getByRole('button', { name: 'Добавить занятие', exact: true }).click();
    await editor().getByRole('button', { name: 'Добавить прогулку', exact: true }).click();
    await editor().getByRole('button', { name: 'Передвинуть «Прогулка по городу» раньше', exact: true }).click();
    await openSection('Дата и время');
    await editor().getByRole('textbox', { name: 'Окончание дня 1', exact: true }).fill('20:00');
    await openSection('Занятия и порядок');
    check(mutations.length === 0, 'Staging launched a calculation');
    await editor().getByRole('heading', { name: 'Занятия и порядок', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/activity-editor-mobile.png', animations: 'disabled' });
    const planned = page.waitForResponse(r => r.url() === base + draftPath + '/plan');
    await apply(); check((await planned).status() === 200, 'Recalculation failed');
    let saved = await api(draftPath);
    check(same(saved.draft.shared, baseline.draft.shared) && same(saved.draft.points, baseline.draft.points), 'Unrelated constraints changed');
    check(same(saved.draft.days[0].activities.map(a => a.label), ['Прогулка по городу', 'Кафе']), 'Walk or food was lost');
    check(saved.draft.days[0].order.length === 1 && saved.draft.days[0].window.end === '20:00', 'Time or order lost');
    check(saved.result && saved.result.days.some(d => d.visits.some(v => v.activity_id === saved.draft.days[0].activities[1].id)), 'Synthetic food visit missing');
    observations.push({ scenario: 'walk_then_food_apply', status: 'PASS', mutations: [...mutations], result_status: saved.result.status,
      synthetic_coverage: saved.result.days.map(d => ({ missing: d.missing_activity_ids.map(id => saved.draft.days[0].activities.find(a => a.id === id)?.label),
        included: d.visits.map(v => saved.draft.days[0].activities.find(a => a.id === v.activity_id)?.label) })) });

    await page.reload(); await openEditor();
    check(await editor().getByRole('button', { name: 'Убрать занятие «Кафе»', exact: true }).count() === 1, 'Reopen lost food');
    await editor().getByRole('button', { name: 'Убрать занятие «Кафе»', exact: true }).click();
    await editor().getByRole('button', { name: 'Добавить занятие', exact: true }).click();
    await editor().getByRole('searchbox', { name: 'Найти занятие', exact: true }).fill('Нет такой категории');
    check(await editor().getByRole('button', { name: 'Добавить выбранное занятие', exact: true }).isDisabled(), 'Unknown category can be added');
    await editor().getByRole('searchbox', { name: 'Найти занятие', exact: true }).fill('каф');
    await editor().getByRole('combobox', { name: 'Вид занятия', exact: true }).selectOption('200');
    await editor().getByRole('button', { name: 'Добавить выбранное занятие', exact: true }).click();
    await editor().getByRole('checkbox', { name: 'Посетить в этом порядке', exact: true }).check();
    const foodReplanned = page.waitForResponse(r => r.url() === base + draftPath + '/plan');
    await apply(); await foodReplanned;
    saved = await api(draftPath);
    check(saved.draft.days[0].activities[1].selection.named_types[0] === 'Кафе', 'Category search failed to retain food intent');
    await page.getByRole('button', { name: 'Мои маршруты', exact: true }).click();
    await editor().getByRole('button', { name: /Прогулка по городу.*Кафе.*текущий/ }).click();
    await editor().waitFor({ state: 'hidden' });
    const reopened = await api('/api/planning/bootstrap');
    check(reopened.view.id === saved.id && same(reopened.view.draft, saved.draft), 'Library reopened different conditions');
    observations.push({ scenario: 'search_category_replace_food_reopen_library', status: 'PASS' });
    await openEditor();
    await editor().getByRole('checkbox', { name: 'Посетить в этом порядке', exact: true }).uncheck();
    await page.setViewportSize({ width: 1280, height: 900 });
    await editor().getByRole('heading', { name: 'Занятия и порядок', exact: true }).scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Wide horizontal overflow');
    await page.screenshot({ path: 'output/playwright/activity-editor-wide.png', animations: 'disabled' });
    const replanned = page.waitForResponse(r => r.url() === base + draftPath + '/plan');
    await apply(); await replanned;
    saved = await api(draftPath); check(saved.draft.days[0].order.length === 0, 'Explicit order removal was ignored');
    observations.push({ scenario: 'reopen_and_remove_order', status: 'PASS' });

    await openEditor(); mutations.length = 0;
    await editor().getByRole('button', { name: 'Убрать занятие «Прогулка по городу»', exact: true }).click();
    await editor().getByRole('button', { name: 'Убрать занятие «Кафе»', exact: true }).click();
    await apply(); saved = await api(draftPath);
    await page.getByRole('heading', { name: 'Чем займёмся?', exact: true }).waitFor();
    check(saved.result === null && saved.issues.some(i => i.code === 'ACTIVITIES_REQUIRED'), 'Empty day treated as a route');
    check(mutations.length === 1 && mutations[0].method === 'PATCH', 'Empty day was confirmed or calculated');
    observations.push({ scenario: 'remove_last_activity_requires_input', status: 'PASS', mutations: [...mutations] });
    return { status: 'PASS', data_mode: 'synthetic', observations };
  } finally { page.off('request', listener); await page.unroute('**/activity-options'); }
}
