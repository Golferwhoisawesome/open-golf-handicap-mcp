import { z } from "zod";
export const courseInputSchema = z
  .object({
    handicapIndex: z.number().finite().min(-10).max(54),
    holes: z.union([z.literal(9), z.literal(18)]),
    slope: z.number().int().min(55).max(155),
    courseRating: z.number().finite().positive().max(90),
    par: z.number().int().min(20).max(80),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.holes === 9 && (v.par > 40 || v.courseRating > 45)) ||
      (v.holes === 18 && (v.par < 40 || v.courseRating < 40))
    )
      ctx.addIssue({
        code: "custom",
        message: "Provide ratings and par for exactly the selected holes",
      });
  });
export function courseHandicap(input: z.infer<typeof courseInputSchema>) {
  const v = courseInputSchema.parse(input),
    index =
      v.holes === 9 ? Math.round(v.handicapIndex * 5) / 10 : v.handicapIndex;
  const unrounded = index * (v.slope / 113) + (v.courseRating - v.par);
  const rounded = Math.round(Number(unrounded.toFixed(10))) || 0;
  return {
    courseHandicap: rounded,
    unrounded,
    holes: v.holes,
    source: "Local calculation using supplied ratings",
    rulesReference: "USGA Rules of Handicapping 6.1a/6.1b (2024)",
    synthetic: true,
    limitation:
      "Educational calculation in mock mode. No course database validation, playing allowance, or official certification.",
  };
}
