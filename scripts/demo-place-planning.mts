import { planPlacesWithDgis } from '../src/server/place-planning.js';
import { demoNow, planningFixture } from '../src/server/place-planning.fixture.js';

const fixture = planningFixture();
const result = await planPlacesWithDgis(fixture.client(), fixture.input, {
  retrieval: { radiusMeters: 5000, maxPages: 1 }, dataMode: 'test', now: demoNow,
});
console.log(JSON.stringify({ demonstration: 'Синтетические HTTP-ответы; настоящий Python/OR-Tools. Сеть и ключи не используются.', result }, null, 2));
if (result.status !== 'AVAILABLE') process.exitCode = 1;
