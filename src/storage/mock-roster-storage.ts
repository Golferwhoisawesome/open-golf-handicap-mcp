import { AppError } from "../domain/errors.js";
import { emptyRoster, rosterSchema, type Roster } from "../domain/models.js";
import type { RosterStorageProvider } from "./roster-storage-provider.js";
export class MockRosterStorage implements RosterStorageProvider {
  readonly kind = "mock";
  private readonly rosters = new Map<string, Roster>();
  private readonly queues = new Map<string, Promise<void>>();
  private async exclusive<T>(
    subject: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!subject.trim() || Buffer.byteLength(subject) > 2048)
      throw new AppError("STORAGE_ERROR", "Invalid storage principal.");
    const preceding = this.queues.get(subject) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(subject, current);
    await preceding;
    try {
      return await work();
    } finally {
      release();
      if (this.queues.get(subject) === current) this.queues.delete(subject);
    }
  }
  read(subject: string): Promise<Roster> {
    return this.exclusive(subject, async () =>
      structuredClone(this.rosters.get(subject) ?? emptyRoster()),
    );
  }
  transact<T>(
    subject: string,
    update: (roster: Roster) => T | Promise<T>,
  ): Promise<T> {
    return this.exclusive(subject, async () => {
      const draft = structuredClone(this.rosters.get(subject) ?? emptyRoster()),
        revision = draft.revision,
        result = await update(draft);
      if (!Number.isSafeInteger(revision + 1))
        throw new AppError("STORAGE_ERROR", "Invalid roster revision.");
      draft.revision = revision + 1;
      const parsed = rosterSchema.safeParse(draft);
      if (!parsed.success)
        throw new AppError("STORAGE_ERROR", "Invalid roster data.");
      this.rosters.set(subject, parsed.data);
      return result;
    });
  }
  delete(subject: string): Promise<void> {
    return this.exclusive(subject, async () => {
      this.rosters.delete(subject);
    });
  }
}
