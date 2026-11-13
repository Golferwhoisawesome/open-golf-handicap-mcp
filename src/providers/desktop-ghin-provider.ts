import { z } from "zod";
import { AppError } from "../domain/errors.js";
import { lookupSchema, type LookupResult } from "../domain/models.js";
import { requestRosterProvider } from "../desktop/session-broker.js";
import type {
  HandicapProvider,
  ProviderConnectionState,
  ProviderContext,
} from "./handicap-provider.js";
import { assertLiveAccessEnabled } from "./live-access.js";

const stateSchema = z
  .object({
    authenticated: z.boolean(),
    connected: z.boolean(),
    credentialsStored: z.boolean(),
    expiresAt: z.iso.datetime().nullable(),
    controlledTest: z.boolean().optional(),
    limitations: z.array(z.string().max(500)).max(10),
  })
  .strict();
const infoSchema = z
  .object({
    id: z.enum(["spicygolf-sdk-offline", "ghin-spicygolf"]),
    capabilities: z
      .object({
        batch: z.boolean(),
        history: z.boolean(),
        scores: z.boolean(),
        updatedSince: z.boolean(),
        courses: z.boolean(),
        live: z.boolean(),
      })
      .strict(),
    state: stateSchema,
  })
  .strict();

/** Client for the owner's existing private session. Has no access to GHIN secrets. */
export class DesktopGhinProvider implements HandicapProvider {
  private disconnected = false;
  private constructor(
    private readonly directory: string,
    private readonly profileId: string,
    private readonly sessionId: string,
    readonly id: string,
    readonly capabilities: z.infer<typeof infoSchema>["capabilities"],
  ) {}
  static async attach(
    directory: string,
    profileId: string,
    sessionId: string,
    mode: "offline-test" | "ghin",
  ) {
    if (mode === "ghin") assertLiveAccessEnabled();
    const info = infoSchema.parse(
      await requestRosterProvider(directory, profileId, sessionId, "status"),
    );
    if (
      info.id !==
        (mode === "ghin" ? "ghin-spicygolf" : "spicygolf-sdk-offline") ||
      info.capabilities.live !== (mode === "ghin")
    )
      throw new AppError(
        "FORBIDDEN",
        "The local connection uses another provider mode.",
      );
    return new DesktopGhinProvider(
      directory,
      profileId,
      sessionId,
      info.id,
      Object.freeze(info.capabilities),
    );
  }
  private owner(context: ProviderContext) {
    if (context.subject !== "local-owner")
      throw new AppError("FORBIDDEN", "Desktop sessions have one owner.");
  }
  async getConnectionState(
    context: ProviderContext,
  ): Promise<ProviderConnectionState> {
    this.owner(context);
    const info = infoSchema.parse(
      await requestRosterProvider(
        this.directory,
        this.profileId,
        this.sessionId,
        "status",
      ),
    );
    if (
      info.id !== this.id ||
      info.capabilities.live !== this.capabilities.live
    )
      throw new AppError("FORBIDDEN", "Provider changed during the session.");
    return {
      ...info.state,
      connected: !this.disconnected && info.state.connected,
      authenticated: !this.disconnected && info.state.authenticated,
    };
  }
  async assertConnected(context: ProviderContext): Promise<void> {
    const state = await this.getConnectionState(context);
    if (
      !state.connected ||
      !state.authenticated ||
      (state.expiresAt !== null && Date.parse(state.expiresAt) <= Date.now())
    )
      throw new AppError("AUTH_REQUIRED", "Reconnect privately first.");
  }
  async getMany(
    context: ProviderContext,
    numbers: string[],
    options?: { updatedSince?: string; signal?: AbortSignal },
  ): Promise<LookupResult[]> {
    await this.assertConnected(context);
    const results = z
      .array(lookupSchema)
      .max(100)
      .parse(
        await requestRosterProvider(
          this.directory,
          this.profileId,
          this.sessionId,
          "getMany",
          {
            numbers,
            updatedSince: options?.updatedSince,
            signal: options?.signal,
          },
        ),
      );
    await this.assertConnected(context);
    if (
      results.some(
        (result) =>
          result.ok &&
          (result.data.synthetic === this.capabilities.live ||
            result.data.source !== this.id),
      )
    )
      throw new AppError(
        "UNAVAILABLE",
        "Provider provenance did not match the session.",
      );
    return results;
  }
  async getHistory(
    context: ProviderContext,
    _number: string,
    _limit: number,
  ): Promise<never> {
    await this.assertConnected(context);
    throw new AppError("UNSUPPORTED", "Official index history is unavailable.");
  }
  async getScores(
    context: ProviderContext,
    _number: string,
    _limit: number,
  ): Promise<never> {
    await this.assertConnected(context);
    throw new AppError("UNSUPPORTED", "Score mapping is unavailable.");
  }
  async disconnect(context: ProviderContext): Promise<void> {
    this.owner(context);
    this.disconnected = true;
    const result = (await requestRosterProvider(
      this.directory,
      this.profileId,
      this.sessionId,
      "disconnect",
    )) as { disconnected?: boolean };
    if (result?.disconnected !== true)
      throw new AppError("UNAVAILABLE", "Disconnect was not confirmed.");
  }
}
