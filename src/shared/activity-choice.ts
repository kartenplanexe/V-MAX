import { z } from 'zod';

export const ActivityChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('walk') }).strict(),
  z.object({ kind: z.literal('place'), category_ids: z.array(z.string().min(1).max(128)).min(1).max(10)
    .refine(ids => new Set(ids).size === ids.length) }).strict(),
]);
export type ActivityChoice = z.infer<typeof ActivityChoiceSchema>;
