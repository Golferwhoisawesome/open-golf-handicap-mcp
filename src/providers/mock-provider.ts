import { AppError } from "../domain/errors.js";
import { formatIndex, type LookupResult } from "../domain/models.js";
import type {
  HandicapProvider,
  ProviderContext,
  HistoryEntry,
  ScoreEntry,
} from "./handicap-provider.js";
const fixtures: Record<string, { name: string; index: number }> = {
  "900000001": { name: "Demo Alpha", index: 12.4 },
  "900000002": { name: "Demo Beta", index: 8.7 },
  "900000003": { name: "Demo Gamma", index: 16.2 },
  "900000004": { name: "Demo Delta", index: 5.9 },
  "900000005": { name: "Demo Plus", index: -0.9 },
};
export class MockHandicapProvider implements HandicapProvider {
  readonly id = "mock";
  readonly capabilities = {
    batch: true,
    history: true,
    scores: true,
    updatedSince: false,
    courses: false,
    live: false,
  };
  async getMany(
    _context: ProviderContext,
    numbers: string[],
    options?: { updatedSince?: string; signal?: AbortSignal },
  ): Promise<LookupResult[]> {
    if (options?.signal?.aborted)
      throw new AppError("UNAVAILABLE", "Request aborted.");
    if (options?.updatedSince)
      throw new AppError(
        "UNSUPPORTED",
        "Mock does not implement delta queries.",
      );
    const retrievedAt = new Date().toISOString();
    return [...new Set(numbers)].map((ghinNumber) => {
      const row = fixtures[ghinNumber];
      return row
        ? {
            ok: true as const,
            data: {
              ghinNumber,
              name: row.name,
              handicapIndex: row.index,
              display: formatIndex(row.index),
              effectiveDate: "2026-10-01",
              retrievedAt,
              source: "mock",
              freshness: "fresh" as const,
              synthetic: true,
            },
          }
        : {
            ok: false as const,
            ghinNumber,
            error: {
              code: "NOT_FOUND",
              message: "No synthetic fixture exists for this number.",
            },
          };
    });
  }
  async getHistory(
    _context: ProviderContext,
    number: string,
    limit: number,
  ): Promise<HistoryEntry[]> {
    const row = fixtures[number];
    if (!row) throw new AppError("NOT_FOUND", "Unknown synthetic golfer.");
    return [
      { effectiveDate: "2026-10-01", handicapIndex: row.index },
      {
        effectiveDate: "2026-09-01",
        handicapIndex: Math.round((row.index + 0.2) * 10) / 10,
      },
    ].slice(0, limit);
  }
  async getScores(
    _context: ProviderContext,
    number: string,
    limit: number,
  ): Promise<ScoreEntry[]> {
    if (!fixtures[number])
      throw new AppError("NOT_FOUND", "Unknown synthetic golfer.");
    return [
      {
        playedOn: "2026-09-28",
        grossScore: 84,
        holes: 18 as const,
        courseName: "Synthetic Test Course",
      },
      {
        playedOn: "2026-09-21",
        grossScore: 86,
        holes: 18 as const,
        courseName: "Synthetic Test Course",
      },
    ].slice(0, limit);
  }
  async disconnect(_context: ProviderContext): Promise<void> {}
}
