import type { Roster } from "../domain/models.js";
export interface RosterStorageProvider {
  readonly kind: string;
  read(subject: string): Promise<Roster>;
  // Callback runs under an exclusive per-owner lock; revision increments exactly once on success.
  transact<T>(
    subject: string,
    update: (roster: Roster) => T | Promise<T>,
  ): Promise<T>;
  delete(subject: string): Promise<void>;
}
