import { SpicyGolfProvider } from "./spicygolf-provider.js";
import type { SpicyGolfFixtureClient } from "./spicygolf-contract.js";

/** Fixed synthetic fixtures only. Numeric labels are never sent to GHIN. */
export function createOfflineSpicyGolfProvider(
  ownerSubject: string,
): SpicyGolfProvider {
  const rows = new Map([
    [
      900000001,
      {
        ghin: 900000001,
        first_name: "Demo",
        last_name: "Alpha",
        hi_value: 12.4,
        handicap_index: 12.4,
        hi_display: "12.4",
      },
    ],
    [
      900000002,
      {
        ghin: 900000002,
        first_name: "Demo",
        last_name: "Beta",
        hi_value: 8.7,
        handicap_index: 8.7,
        hi_display: "8.7",
      },
    ],
    [
      900000003,
      {
        ghin: 900000003,
        first_name: "Demo",
        last_name: "Gamma",
        hi_value: 16.2,
        handicap_index: 16.2,
        hi_display: "16.2",
      },
    ],
    [
      900000004,
      {
        ghin: 900000004,
        first_name: "Demo",
        last_name: "Delta",
        hi_value: 5.9,
        handicap_index: 5.9,
        hi_display: "5.9",
      },
    ],
    // The library's numeric coercion loses the display's plus sign.
    [
      900000005,
      {
        ghin: 900000005,
        first_name: "Demo",
        last_name: "Plus",
        hi_value: 0.9,
        handicap_index: 0.9,
        hi_display: "+0.9",
      },
    ],
  ]);
  const client: SpicyGolfFixtureClient = {
    fixtureOnly: true,
    golfers: {
      async getMany(numbers, request) {
        const golfers = numbers.flatMap((number) => {
          const row = rows.get(number);
          return row &&
            (!request.updated_since || request.updated_since < "2026-10-01")
            ? [
                {
                  ...row,
                  rev_date: new Date("2026-10-01T00:00:00.000Z"),
                  status: "Active",
                },
              ]
            : [];
        });
        return {
          isErr: () => false,
          value: {
            golfers,
            missing: numbers.filter(
              (number) => !golfers.some((row) => row.ghin === number),
            ),
          },
        };
      },
    },
  };
  return new SpicyGolfProvider({
    mode: "offline-fixture",
    ownerSubject,
    client,
    allowNames: true,
  });
}
