/** The read-only SpicyGolf 0.20.1 getMany shape, for injected fixtures only.
 * The marker is an integration guard, not a sandbox for arbitrary JavaScript.
 * No SDK, credentials, endpoints, or network transport are constructed here.
 */
export interface SpicyGolfResult {
  isErr(): boolean;
  readonly value?: unknown;
  readonly error?: unknown;
}
export interface SpicyGolfFixtureClient {
  readonly fixtureOnly: true;
  readonly golfers: {
    getMany(
      numbers: number[],
      request: { status: null; updated_since?: string },
    ): Promise<SpicyGolfResult>;
  };
}
export interface OfflineSpicyGolfOptions {
  mode: "offline-fixture";
  ownerSubject: string;
  client: SpicyGolfFixtureClient;
  allowNames?: boolean;
  batchSize?: number;
  /** Bounds waiting; the actual library has no exposed cancellation contract. */
  timeoutMs?: number;
  now?: () => Date;
}
