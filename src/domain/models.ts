import { z } from "zod";
// Plausibility only, not a GHIN-assigned identity guarantee. Mock IDs never leave this process.
export const ghinSchema = z
  .string()
  .regex(/^\d{6,10}$/)
  .refine((v) => Number(v) > 0, "GHIN number must be positive");
export const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (v) => !/[\u0000-\u001f\u007f]/.test(v),
    "Control characters are not permitted",
  );
export const golferInputSchema = z
  .object({
    name: nameSchema,
    ghinNumber: ghinSchema,
    nickname: nameSchema.optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();
export type GolferInput = z.infer<typeof golferInputSchema>;
export const handicapSchema = z.object({
  ghinNumber: ghinSchema,
  name: z.string().optional(),
  handicapIndex: z.number().finite().min(-10).max(54),
  display: z.string(),
  effectiveDate: z.string().nullable(),
  retrievedAt: z.iso.datetime(),
  source: z.string(),
  freshness: z.enum(["fresh", "cached"]),
  synthetic: z.boolean(),
});
export type Handicap = z.infer<typeof handicapSchema>;
export const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryAfterMs: z.number().optional(),
});
export type PublicError = z.infer<typeof errorSchema>;
export const lookupSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: handicapSchema }),
  z.object({
    ok: z.literal(false),
    ghinNumber: ghinSchema,
    error: errorSchema,
  }),
]);
export type LookupResult = z.infer<typeof lookupSchema>;
export const savedGolferSchema = golferInputSchema.extend({
  id: z.string(),
  createdAt: z.iso.datetime(),
  modifiedAt: z.iso.datetime(),
  lastCheckedAt: z.iso.datetime().nullable(),
  lastAttemptAt: z.iso.datetime().nullable(),
  handicap: handicapSchema.nullable(),
  lastError: errorSchema.nullable(),
});
export type SavedGolfer = z.infer<typeof savedGolferSchema>;
export const changeSchema = z.object({
  golferId: z.string(),
  ghinNumber: ghinSchema,
  previous: z.number().nullable(),
  current: z.number(),
  observedAt: z.iso.datetime(),
  retrievedAt: z.iso.datetime(),
  source: z.string(),
  synthetic: z.boolean(),
});
export type HandicapChange = z.infer<typeof changeSchema>;
export const rosterSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  golfers: z.array(savedGolferSchema).max(500),
  changes: z.array(changeSchema).max(5000),
});
export type Roster = z.infer<typeof rosterSchema>;
export const emptyRoster = (): Roster => ({
  schemaVersion: 1,
  revision: 0,
  golfers: [],
  changes: [],
});
export interface Principal {
  subject: string;
  scopes: string[];
}
export const formatIndex = (value: number) =>
  value < 0 ? `+${Math.abs(value).toFixed(1)}` : value.toFixed(1);
