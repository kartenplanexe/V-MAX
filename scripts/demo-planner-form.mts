import fastifyStatic from '@fastify/static';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLocalPlanningDemo } from '../src/server/local-planning-demo.js';

const root = fileURLToPath(new URL('../dist/client/', import.meta.url));

const html = (await readFile(new URL('../dist/client/index.html', import.meta.url), 'utf8'))
  .replace(/<script src="https:\/\/st\.max\.ru\/js\/max-web-app\.js"><\/script>/u, '<script src="/demo-launch.js"></script>');
const app = createLocalPlanningDemo({ now: () => new Date() });
app.get('/demo-launch.js', async (_request, reply) => reply.type('application/javascript').send(
  "fetch('/api/demo/session',{method:'POST'}).then(r=>{if(!r.ok)throw new Error('Demo session failed');return r.json()}).then(s=>{window.WebApp={initData:s.token}}).catch(()=>{});"));
await app.register(fastifyStatic, { root, index: false });
app.get('/planner-form', async (_request, reply) => reply.type('text/html').send(html));
app.get('/', async (_request, reply) => reply.redirect('/planner-form'));
await app.listen({ host: '127.0.0.1', port: 4174 });
console.log('Откройте http://127.0.0.1:4174/planner-form');
console.log('Учебные места и время в пути; настоящий Python/OR-Tools. Без ключей, LLM и внешних запросов. Ctrl+C - остановить.');
