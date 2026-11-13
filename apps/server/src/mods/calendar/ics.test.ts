import { assert, describe, it } from "@effect/vitest";

import * as DateTime from "effect/DateTime";

import { occurrencesBetween } from "./ics.ts";

const calendar = (...events: ReadonlyArray<string>) =>
  [
    "BEGIN:VCALENDAR",
    "X-WR-CALNAME:euan@zeroheight.com",
    "X-WR-TIMEZONE:Europe/London",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/London",
    "BEGIN:STANDARD",
    "DTSTART:19701025T020000",
    "END:STANDARD",
    "END:VTIMEZONE",
    ...events.flatMap((event) => ["BEGIN:VEVENT", event, "END:VEVENT"]),
    "END:VCALENDAR",
  ].join("\r\n");

const at = (iso: string) => DateTime.makeUnsafe(iso).epochMilliseconds;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const summarize = (ics: string, from: string, to: string) =>
  occurrencesBetween(ics, at(from), at(to)).map((occurrence) => ({
    title: occurrence.title,
    startsAt: iso(occurrence.startsAt),
    endsAt: iso(occurrence.endsAt),
    joinUrl: occurrence.joinUrl,
  }));

describe("occurrencesBetween", () => {
  const standup = calendar(
    [
      "UID:standup",
      "SUMMARY:Standup",
      "DTSTART;TZID=Europe/London:20261019T093000",
      "DTEND;TZID=Europe/London:20261019T100000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
    ].join("\r\n"),
  );

  it("keeps a weekly meeting at its local time across the clocks going back", () => {
    assert.deepStrictEqual(
      summarize(standup, "2026-10-23T00:00:00Z", "2026-10-27T00:00:00Z").map((o) => o.startsAt),
      ["2026-10-23T08:30:00.000Z", "2026-10-26T09:30:00.000Z"],
    );
  });

  it("drops excluded and cancelled instances and uses moved ones", () => {
    const ics = calendar(
      [
        "UID:sync",
        "SUMMARY:Sync",
        "DTSTART;TZID=Europe/London:20261102T140000",
        "DTEND;TZID=Europe/London:20261102T143000",
        "RRULE:FREQ=DAILY;COUNT=5",
        "EXDATE;TZID=Europe/London:20261103T140000",
      ].join("\r\n"),
      [
        "UID:sync",
        "RECURRENCE-ID;TZID=Europe/London:20261104T140000",
        "SUMMARY:Sync (moved)",
        "DTSTART;TZID=Europe/London:20261104T160000",
        "DTEND;TZID=Europe/London:20261104T163000",
      ].join("\r\n"),
      [
        "UID:sync",
        "RECURRENCE-ID;TZID=Europe/London:20261105T140000",
        "STATUS:CANCELLED",
        "DTSTART;TZID=Europe/London:20261105T140000",
        "DTEND;TZID=Europe/London:20261105T143000",
      ].join("\r\n"),
    );
    assert.deepStrictEqual(
      summarize(ics, "2026-11-01T00:00:00Z", "2026-11-10T00:00:00Z").map(
        (o) => `${o.title} ${o.startsAt}`,
      ),
      [
        "Sync 2026-11-02T14:00:00.000Z",
        "Sync (moved) 2026-11-04T16:00:00.000Z",
        "Sync 2026-11-06T14:00:00.000Z",
      ],
    );
  });

  it("keeps ongoing timed meetings and skips all-day, declined and finished ones", () => {
    const ics = calendar(
      [
        "UID:review",
        "SUMMARY:Design review\\, round 2",
        "DTSTART:20261112T150000Z",
        "DTEND:20261112T160000Z",
        "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
        "DESCRIPTION:Agenda in the doc. Zoom fallback: https://zeroheight.zoom.us/j/1",
        " 23",
        "BEGIN:VALARM",
        "DESCRIPTION:Reminder https://meet.google.com/not-this-one",
        "END:VALARM",
      ].join("\r\n"),
      [
        "UID:retro",
        "SUMMARY:Retro",
        "DTSTART:20261112T170000Z",
        "DTEND:20261112T173000Z",
        "LOCATION:https://zeroheight.zoom.us/j/9988",
      ].join("\r\n"),
      [
        "UID:holiday",
        "SUMMARY:Holiday",
        "DTSTART;VALUE=DATE:20261112",
        "DTEND;VALUE=DATE:20261113",
      ].join("\r\n"),
      [
        "UID:declined",
        "SUMMARY:All hands",
        "DTSTART:20261112T163000Z",
        "DTEND:20261112T170000Z",
        "ATTENDEE;CN=Euan;PARTSTAT=DECLINED:mailto:euan@zeroheight.com",
      ].join("\r\n"),
      ["UID:done", "SUMMARY:Earlier", "DTSTART:20261112T130000Z", "DTEND:20261112T140000Z"].join(
        "\r\n",
      ),
    );
    assert.deepStrictEqual(summarize(ics, "2026-11-12T15:30:00Z", "2026-11-13T15:30:00Z"), [
      {
        title: "Design review, round 2",
        startsAt: "2026-11-12T15:00:00.000Z",
        endsAt: "2026-11-12T16:00:00.000Z",
        joinUrl: "https://meet.google.com/abc-defg-hij",
      },
      {
        title: "Retro",
        startsAt: "2026-11-12T17:00:00.000Z",
        endsAt: "2026-11-12T17:30:00.000Z",
        joinUrl: "https://zeroheight.zoom.us/j/9988",
      },
    ]);
  });

  it("finds the last Friday of the month and stops at UNTIL", () => {
    const ics = calendar(
      [
        "UID:demo",
        "SUMMARY:Demo",
        "DTSTART;TZID=Europe/London:20260130T160000",
        "DTEND;TZID=Europe/London:20260130T170000",
        "RRULE:FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231T000000Z",
      ].join("\r\n"),
    );
    assert.deepStrictEqual(
      summarize(ics, "2026-11-01T00:00:00Z", "2027-02-01T00:00:00Z").map((o) => o.startsAt),
      ["2026-11-27T16:00:00.000Z", "2026-12-25T16:00:00.000Z"],
    );
  });
});
