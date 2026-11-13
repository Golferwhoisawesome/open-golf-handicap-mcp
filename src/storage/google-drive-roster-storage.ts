import { AppError } from "../domain/errors.js";
import type { Roster } from "../domain/models.js";
import type { RosterStorageProvider } from "./roster-storage-provider.js";
/** Reserved extension point. Separate Drive OAuth and concurrency controls are required. */
export class GoogleDriveRosterStorage implements RosterStorageProvider {
  readonly kind = "google-drive-unavailable";
  async read(_subject: string): Promise<Roster> {
    return this.unavailable();
  }
  async transact<T>(
    _subject: string,
    _update: (roster: Roster) => T | Promise<T>,
  ): Promise<T> {
    return this.unavailable();
  }
  async delete(_subject: string): Promise<void> {
    return this.unavailable();
  }
  private unavailable(): never {
    throw new AppError(
      "UNSUPPORTED",
      "Google Drive storage is not implemented.",
    );
  }
}
