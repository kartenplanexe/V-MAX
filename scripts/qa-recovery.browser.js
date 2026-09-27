// Playwright CLI run-code file, exclusively for scripts/qa-ui-local.mts.
// No production credentials, provider requests or MAX messages are used.
async page => {
  const base = 'http://127.0.0.1:4175', bootstrap = base + '/api/planning/bootstrap';
  if (!page.url().startsWith(base + '/')) throw new Error('Open the synthetic loopback UI in a separate browser session first');
  const headers = { Origin: base, 'X-Max-Init-Data': 'qa-synthetic:result' };
  const observations = [], requests = [];
  const check = (condition, reason) => { if (!condition) throw new Error(reason); };
  const record = request => {
    const url = request.url();
    if (url.startsWith(base + '/api/')) requests.push(request.method() + ' ' + url.slice(base.length).split('?')[0].replace(/\/drafts\/[^/]+/, '/drafts/:id'));
  };
  async function savedToDraft() {
    await page.getByRole('button', { name: 'Продолжить с этими условиями', exact: true }).click();
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    await page.getByRole('button', { name: 'Учебный город', exact: true }).click();
    await page.getByRole('complementary', { name: 'Условия маршрута', exact: true }).waitFor();
  }
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/?qa=result');
    await page.getByRole('button', { name: 'Мои маршруты', exact: true }).waitFor();
    check(await page.getByText('Локальная QA', { exact: false }).count() === 1, 'Missing synthetic-mode label');
    if (await page.getByRole('button', { name: 'Продолжить с этими условиями', exact: true }).count()) await savedToDraft();
    await page.getByRole('complementary', { name: 'Условия маршрута', exact: true }).getByRole('button', { name: 'Изменить условия', exact: true }).click();
    const timeSection = page.getByRole('dialog').getByRole('heading', { name: 'Дата и время', exact: true });
    if (!await timeSection.evaluate(node => node.closest('details').open)) await timeSection.click();
    const end = page.locator('input[aria-label="Окончание дня 1"]');
    const oldEnd = await end.inputValue(), newEnd = oldEnd === '20:00' ? '21:00' : '20:00';
    const oldDate = await page.getByRole('textbox', { name: 'Дата дня 1', exact: true }).inputValue();
    await end.fill(newEnd);
    check((await page.request.post(base + '/qa/clock/expire-drafts', { headers })).status() === 200, 'Synthetic clock control failed');
    await page.getByRole('button', { name: /^Применить (условия|и пересчитать)$/ }).click();
    await page.getByRole('dialog').getByText('Этот черновик больше недоступен.', { exact: false }).waitFor();
    page.on('request', record);
    await page.getByRole('dialog').getByRole('button', { name: 'Загрузить сохранённую версию', exact: true }).click();
    check(await page.locator('dialog[open]').count() === 2, 'Missing explicit discard confirmation');
    await page.getByRole('button', { name: 'Продолжить правку', exact: true }).click();
    check(await end.inputValue() === newEnd && requests.length === 0, 'Cancel lost edits or requested the server');
    check(await page.evaluate(() => document.documentElement.style.overflow) === 'hidden', 'Still-open editor lost scroll lock');
    check((await page.evaluate(() => document.activeElement?.textContent))?.includes('Загрузить сохранённую версию'), 'Cancel lost keyboard focus');
    await page.getByRole('dialog').getByRole('button', { name: 'Загрузить сохранённую версию', exact: true }).click();
    await page.route(bootstrap, route => route.abort('failed'));
    await page.getByRole('button', { name: 'Загрузить сохранённую версию', exact: true }).last().click();
    await page.getByRole('dialog').last().getByText('Не удалось связаться с сервисом.', { exact: false }).waitFor();
    check(await end.inputValue() === newEnd, 'Failed read discarded edits');
    await page.screenshot({ path: 'output/playwright/recovery-final-mobile.png' });
    await page.unroute(bootstrap);
    await page.getByRole('button', { name: 'Загрузить сохранённую версию', exact: true }).last().click();
    await page.getByRole('heading', { name: 'Вернёмся к вашему плану', exact: true }).waitFor();
    check(JSON.stringify(requests) === JSON.stringify(['GET /api/planning/bootstrap', 'GET /api/planning/bootstrap']), 'Recovery retried a mutation');
    check(await page.locator('dialog[open]').count() === 0, 'Recovery left a modal open');
    check(await page.evaluate(() => document.documentElement.style.overflow) !== 'hidden', 'Recovery left page scroll locked');
    observations.push({ scenario: 'expired_edit_cancel_failed_read_then_recovery', result: 'PASS', recovery_requests: [...requests], preserved_unsaved_end: newEnd });
    requests.length = 0;
    await savedToDraft();
    check(!requests.some(value => /\/(plan|confirm)$/.test(value)), 'Restoration calculated without confirmation');
    await page.getByRole('complementary', { name: 'Условия маршрута', exact: true }).getByRole('button', { name: 'Изменить условия', exact: true }).click();
    if (!await timeSection.evaluate(node => node.closest('details').open)) await timeSection.click();
    check(await end.inputValue() === oldEnd && await page.getByRole('textbox', { name: 'Дата дня 1', exact: true }).inputValue() === oldDate, 'Restoration changed saved date/time');
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть панель', exact: true }).click();
    observations.push({ scenario: 'restore_without_calculation', result: 'PASS', saved_date_and_time_unchanged: true });

    await page.route(bootstrap, route => route.abort('failed'));
    await page.reload();
    await page.getByRole('button', { name: 'Попробовать снова', exact: true }).waitFor();
    check(await page.getByRole('link', { name: 'Открыть чат с ботом', exact: false }).count() === 0, 'Network failure shown as missing MAX login');
    await page.unroute(bootstrap); requests.length = 0;
    await page.getByRole('button', { name: 'Попробовать снова', exact: true }).click();
    await page.getByRole('complementary', { name: 'Условия маршрута', exact: true }).waitFor();
    check(JSON.stringify(requests) === JSON.stringify(['GET /api/planning/bootstrap']), 'Initial retry performed a mutation');
    observations.push({ scenario: 'initial_network_retry', result: 'PASS' });

    const library = await page.request.get(base + '/api/planning/saved', { headers });
    check(library.status() === 200, 'Synthetic saved library unavailable');
    const item = (await library.json()).items[0]; check(item, 'No synthetic route to share');
    const created = await page.request.post(base + '/api/planning/shares', { headers, data: {
      draft_id: item.id, base_revision: item.revision, event_id: '00000000-0000-4000-8000-000000002709', include_private_points: false } });
    check(created.status() === 200, 'Synthetic share creation failed');
    const link = (await created.json()).deep_link;
    check(link.startsWith(base + '/?qa=initial&share='), 'Unexpected share origin');
    await page.route(bootstrap, route => route.abort('failed'));
    await page.goto(link);
    await page.getByRole('button', { name: 'Попробовать снова', exact: true }).waitFor();
    await page.unroute(bootstrap); requests.length = 0;
    await page.getByRole('button', { name: 'Попробовать снова', exact: true }).click();
    await page.getByRole('heading', { name: 'С вами поделились планом', exact: true }).waitFor();
    check(JSON.stringify(requests) === JSON.stringify(['GET /api/planning/bootstrap', 'POST /api/planning/shares/resolve']), 'Share launch lost its target or imported automatically');
    observations.push({ scenario: 'share_launch_retry', result: 'PASS', read_only_requests: [...requests] });

    await page.route(bootstrap, route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"AUTH_REQUIRED"}' }));
    await page.reload();
    await page.getByRole('link', { name: 'Открыть чат с ботом', exact: false }).waitFor();
    check(await page.getByRole('button', { name: 'Попробовать снова', exact: true }).count() === 0, 'Invalid auth offered state recovery');
    await page.unroute(bootstrap);
    await page.route(bootstrap, route => route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }));
    await page.reload();
    await page.getByRole('button', { name: 'Попробовать снова', exact: true }).waitFor();
    await page.getByText('Не удалось прочитать ответ сервиса. Попробуйте загрузить данные снова.', { exact: true }).waitFor();
    check(await page.getByRole('link', { name: 'Открыть чат с ботом', exact: false }).count() === 0, 'Malformed response shown as missing auth');
    observations.push({ scenario: 'auth_401_and_malformed_200', result: 'PASS' });
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      check(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'Horizontal overflow at ' + width);
    }
    await page.screenshot({ path: 'output/playwright/recovery-final-wide.png' });
    return { result: 'PASS', data_mode: 'synthetic', widths: [390, 1280], observations };
  } finally { await page.unroute(bootstrap); page.off('request', record); }
}
