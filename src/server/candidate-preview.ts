import { z } from 'zod';
import { CandidatePlace, CandidatePreview } from '../shared/candidate-preview-schema.js';
import { candidateSourceLink } from '../shared/candidate-preview.js';

/** Only the canonical, eligibility-filtered shortlist of this operation may be exposed. */
export function projectCandidatePreview(job: Record<string, unknown> | undefined, now: Date) {
  if (!job || !Array.isArray(job.places) || !Array.isArray(job.candidate_pool)) return {};
  const places = new Map<string, z.infer<typeof CandidatePlace>>();
  for (const raw of job.places) {
    if (!raw || typeof raw !== 'object') continue;
    const parsed = CandidatePlace.safeParse({ place_id: raw.id, name: raw.name,
      location_label: raw.location_label ?? null, source: raw.source });
    if (!parsed.success) continue;
    const place = parsed.data;
    const expires = Math.min(Date.parse(place.source.valid_until), Date.parse(place.source.fetched_at) + 300_000);
    if (Date.parse(place.source.fetched_at) > now.getTime() || expires <= now.getTime()) continue;
    place.source.url = candidateSourceLink(place.source);
    place.source.valid_until = new Date(expires).toISOString(); places.set(place.place_id, place);
  }
  const groups = new Map<string, z.infer<typeof CandidatePreview>['groups'][number]>();
  for (const item of job.candidate_pool) {
    const parsed = z.object({ day_id: z.string(), activity_id: z.string(), place_id: z.string() }).safeParse(item);
    if (!parsed.success) continue;
    const ref = parsed.data, place = places.get(ref.place_id); if (!place) continue;
    const key = JSON.stringify([ref.day_id, ref.activity_id]);
    const group = groups.get(key) ?? { day_id: ref.day_id, activity_id: ref.activity_id, places: [] };
    if (!group.places.some(value => value.place_id === place.place_id)) group.places.push(place);
    groups.set(key, group);
  }
  const parsed = CandidatePreview.safeParse({ groups: [...groups.values()] });
  if (!parsed.success) return {};
  return { candidate_preview: parsed.data,
    valid_until: new Date(Math.min(...parsed.data.groups.flatMap(group => group.places.map(place => Date.parse(place.source.valid_until))))).toISOString() };
}
