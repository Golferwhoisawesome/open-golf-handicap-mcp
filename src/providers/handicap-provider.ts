import type { LookupResult } from "../domain/models.js";
export interface ProviderCapabilities {
  batch: boolean;
  history: boolean;
  scores: boolean;
  updatedSince: boolean;
  courses: boolean;
  live: boolean;
}
export interface ProviderContext {
  subject: string;
}
export interface ProviderConnectionState {
  authenticated: boolean;
  connected: boolean;
  credentialsStored: boolean;
  expiresAt: string | null;
  controlledTest?: boolean;
  limitations: string[];
}
export interface HistoryEntry {
  effectiveDate: string;
  handicapIndex: number;
}
export interface ScoreEntry {
  playedOn: string;
  grossScore: number;
  holes: 9 | 18;
  courseName?: string;
}
export interface HandicapProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  getConnectionState?(
    context: ProviderContext,
  ): Promise<ProviderConnectionState>;
  /** Must reject revoked, disconnected or expired sessions before cache access. */
  assertConnected?(context: ProviderContext): Promise<void>;
  getMany(
    context: ProviderContext,
    numbers: string[],
    options?: { updatedSince?: string; signal?: AbortSignal },
  ): Promise<LookupResult[]>;
  getHistory(
    context: ProviderContext,
    number: string,
    limit: number,
  ): Promise<HistoryEntry[]>;
  getScores(
    context: ProviderContext,
    number: string,
    limit: number,
  ): Promise<ScoreEntry[]>;
  disconnect(context: ProviderContext): Promise<void>;
}
