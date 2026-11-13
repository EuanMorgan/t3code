import { CalendarFeedError, type CalendarStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { occurrencesBetween } from "./ics.ts";

export class Calendar extends Context.Service<
  Calendar,
  {
    /** The next day's meetings, refreshed while someone is watching. */
    readonly status: Stream.Stream<CalendarStatus>;
    /** Checks and saves a Google Calendar iCal link, or forgets it when `url` is null. */
    readonly setFeed: (url: string | null) => Effect.Effect<void, CalendarFeedError>;
  }
>()("t3/mods/calendar/Calendar") {}

const FEED_SECRET = "mods-calendar-ical-url";
const LOOKAHEAD_MS = 24 * 60 * 60 * 1000;
const NOT_CONFIGURED: CalendarStatus = { configured: false, events: [], error: null };

const normalizeFeedUrl = (input: string) => {
  const trimmed = input.trim().replace(/^webcal:\/\//iu, "https://");
  const url = URL.canParse(trimmed) ? new URL(trimmed) : null;
  return url?.protocol === "https:" ? url.toString() : null;
};

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

  const saved = yield* secrets.get(FEED_SECRET).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read the saved calendar link", { cause }).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
  );
  const feedUrl = yield* SubscriptionRef.make(Option.getOrNull(saved));

  const download = Effect.fn("Calendar.download")(function* (url: string) {
    const response = yield* client.execute(HttpClientRequest.get(url));
    return yield* response.text;
  }, Effect.timeout("20 seconds"));

  const read = Effect.fn("Calendar.read")(function* (url: string) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return yield* download(url).pipe(
      Effect.map((ics): CalendarStatus => ({
        configured: true,
        events: occurrencesBetween(ics, now, now + LOOKAHEAD_MS).map((occurrence) => ({
          title: occurrence.title,
          startsAt: DateTime.makeUnsafe(occurrence.startsAt),
          endsAt: DateTime.makeUnsafe(occurrence.endsAt),
          joinUrl: occurrence.joinUrl,
        })),
        error: null,
      })),
      Effect.catch((cause) =>
        Effect.logWarning("Could not read the calendar", { cause }).pipe(
          Effect.as<CalendarStatus>({
            configured: true,
            events: [],
            error: "Couldn't read your calendar. Check the link in Settings → Plugins.",
          }),
        ),
      ),
    );
  });

  const watch = SubscriptionRef.changes(feedUrl).pipe(
    Stream.switchMap((url) =>
      url === null
        ? Stream.make(NOT_CONFIGURED)
        : Stream.fromEffect(read(url)).pipe(Stream.repeat(Schedule.spaced("5 minutes"))),
    ),
  );

  // One reader for every client, running only while someone is subscribed.
  const status = yield* Stream.share(watch, {
    capacity: 1,
    strategy: "sliding",
    replay: 1,
    idleTimeToLive: "1 minute",
  });

  return Calendar.of({
    status,
    setFeed: Effect.fn("Calendar.setFeed")(function* (input) {
      if (input === null) {
        yield* secrets.remove(FEED_SECRET).pipe(Effect.ignore);
        yield* SubscriptionRef.set(feedUrl, null);
        return;
      }
      const url = normalizeFeedUrl(input);
      if (url === null) {
        return yield* new CalendarFeedError({ message: "Paste an https:// iCal link." });
      }
      const ics = yield* download(url).pipe(
        Effect.mapError(
          () =>
            new CalendarFeedError({
              message: "That link didn't load. Copy the secret iCal address again.",
            }),
        ),
      );
      if (!ics.includes("BEGIN:VCALENDAR")) {
        return yield* new CalendarFeedError({ message: "That link isn't an iCal calendar." });
      }
      yield* secrets
        .set(FEED_SECRET, new TextEncoder().encode(url))
        .pipe(Effect.mapError(() => new CalendarFeedError({ message: "Couldn't save the link." })));
      yield* SubscriptionRef.set(feedUrl, url);
    }),
  });
});

export const layer = Layer.effect(Calendar, make).pipe(Layer.provide(ServerSecretStore.layer));
