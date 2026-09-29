import { z } from 'zod';
import { CandidatePlace, CandidatePreview, SelectionGaps } from '../shared/candidate-preview-schema.js';
import { candidateSourceLink } from '../shared/candidate-preview.js';

/** Only the canonical, eligibility-filtered shortlist of this operation may be exposed. */
export function projectCandidatePreview(job: Record<string, unknown> | undefined, now: Date): {
  candidate_preview?: z.infer<typeof CandidatePreview>; selection_gaps?: z.infer<typeof SelectionGaps>; valid_until?: string;
} {
  if (!job || !Array.isArray(job.places) || !Array.isArray(job.candidate_pool)) return {};
  const parsedGaps = SelectionGaps.safeParse(job.selection_gaps);
  const gaps = parsedGaps.success ? { selection_gaps: parsedGaps.data } : {};
  const places = new Map<string, z.infer<typeof CandidatePlace>>();
  for (const raw of job.places) {
    if (!raw || typeof raw !== 'object') continue;
    const parsed = CandidatePlace.safeParse({ place_id: raw.id, name: raw.name,
      location_label: raw.location_label ?? null, source: raw.source });
    if (!parsed.success) continue;
    const place = parsed.data;
    const point = CandidatePlace.shape.point.safeParse(raw.point);
    if (point.success && point.data) place.point = point.data;
    const expires = Math.min(Date.parse(place.source.valid_until), Date.parse(place.source.fetched_at) + 300_000);
    if (Date.parse(place.source.fetched_at) > now.getTime() || expires <= now.getTime()) continue;
    place.source.url = candidateSourceLink(place.source);
    place.source.valid_until = new Date(expires).toISOString(); places.set(place.place_id, place);
  }
  const groups = new Map<string, z.infer<typeof CandidatePreview>['groups'][number]>();
  for (const item of job.candidate_pool) {
    const parsed = z.object({ day_id: z.string(), activity_id: z.string(), place_id: z.string(),
      estimated_visit_minutes: CandidatePlace.shape.estimated_visit_minutes, event_visit: CandidatePlace.shape.event_visit }).safeParse(item);
    if (!parsed.success) continue;
    const ref = parsed.data, place = places.get(ref.place_id); if (!place) continue;
    const key = JSON.stringify([ref.day_id, ref.activity_id]);
    const group = groups.get(key) ?? { day_id: ref.day_id, activity_id: ref.activity_id, places: [] };
    if (!group.places.some(value => value.place_id === place.place_id)) group.places.push({ ...place,
      ...(ref.event_visit ? { event_visit: ref.event_visit } : {}),
      ...(ref.estimated_visit_minutes !== undefined ? { estimated_visit_minutes: ref.estimated_visit_minutes } : {}) });
    groups.set(key, group);
  }
  const parsed = CandidatePreview.safeParse({ groups: [...groups.values()] });
  if (!parsed.success) return gaps;
  return { ...gaps, candidate_preview: parsed.data,
    valid_until: new Date(Math.min(...parsed.data.groups.flatMap(group => group.places.map(place => Date.parse(place.source.valid_until))))).toISOString() };
}
