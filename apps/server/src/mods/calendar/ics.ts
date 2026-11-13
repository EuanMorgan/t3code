import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export interface CalendarOccurrence {
  readonly title: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly joinUrl: string | null;
}

interface Property {
  readonly name: string;
  readonly params: ReadonlyMap<string, string>;
  readonly value: string;
}

interface WallTime {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

type IcsTime =
  | { readonly kind: "date"; readonly day: number }
  | { readonly kind: "instant"; readonly ms: number }
  | { readonly kind: "wall"; readonly wall: WallTime; readonly timeZone: string | undefined };

interface VEvent {
  readonly uid: string;
  readonly title: string;
  readonly start: IcsTime;
  readonly end: IcsTime | undefined;
  readonly durationMs: number | undefined;
  readonly rrule: ReadonlyMap<string, string> | undefined;
  readonly exdates: ReadonlyArray<IcsTime>;
  readonly recurrenceId: IcsTime | undefined;
  readonly cancelled: boolean;
  readonly declined: boolean;
  readonly joinUrl: string | null;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const MAX_RULE_PERIODS = 20_000;
const JOIN_URL =
  /https:\/\/(?:meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|whereby\.com)\/[^\s"<>\\,;]+/u;

const unfold = (ics: string) => ics.replace(/\r?\n[ \t]/gu, "").split(/\r?\n/u);

const unescapeText = (value: string) =>
  value.replace(/\\([\\;,nN])/gu, (_, char: string) =>
    char === "n" || char === "N" ? "\n" : char,
  );

const parseLine = (line: string): Property | null => {
  let inQuotes = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') inQuotes = !inQuotes;
    if (char === ":" && !inQuotes) {
      const [name = "", ...rawParams] = line.slice(0, index).split(";");
      const params = new Map(
        rawParams.map((param) => {
          const separator = param.indexOf("=");
          return [
            param.slice(0, separator).toUpperCase(),
            param.slice(separator + 1).replace(/^"|"$/gu, ""),
          ] as const;
        }),
      );
      return { name: name.toUpperCase(), params, value: line.slice(index + 1) };
    }
  }
  return null;
};

const dayNumber = (year: number, month: number, day: number) =>
  Date.UTC(year, month - 1, day) / DAY_MS;

const dayParts = (day: number) => DateTime.toPartsUtc(DateTime.makeUnsafe(day * DAY_MS));

const weekdayOf = (day: number) => (((day + 4) % 7) + 7) % 7;

const parseTime = (value: string, timeZone: string | undefined): IcsTime | null => {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/u.exec(value.trim());
  if (match === null) return null;
  const [, year, month, date, hour, minute, second, utc] = match;
  const day = dayNumber(Number(year), Number(month), Number(date));
  if (hour === undefined) return { kind: "date", day };
  const wall = { day, hour: Number(hour), minute: Number(minute), second: Number(second) };
  if (utc !== undefined) return { kind: "instant", ms: day * DAY_MS + wallOffsetMs(wall) };
  return { kind: "wall", wall, timeZone };
};

const wallOffsetMs = (wall: WallTime) => ((wall.hour * 60 + wall.minute) * 60 + wall.second) * 1000;

const resolveWall = (wall: WallTime, timeZone: string | undefined): number => {
  const { year, month, day } = dayParts(wall.day);
  const parts = { year, month, day, hour: wall.hour, minute: wall.minute, second: wall.second };
  // Floating times, and zones Intl does not know, read as the server's local time.
  const zoned = Option.getOrElse(
    DateTime.makeZoned(parts, {
      timeZone: timeZone ?? DateTime.zoneMakeLocal(),
      adjustForTimeZone: true,
    }),
    () =>
      DateTime.makeZonedUnsafe(parts, {
        timeZone: DateTime.zoneMakeLocal(),
        adjustForTimeZone: true,
      }),
  );
  return zoned.epochMilliseconds;
};

const resolve = (time: IcsTime, defaultZone: string | undefined): number => {
  switch (time.kind) {
    case "instant":
      return time.ms;
    case "wall":
      return resolveWall(time.wall, time.timeZone ?? defaultZone);
    case "date":
      return resolveWall({ day: time.day, hour: 0, minute: 0, second: 0 }, defaultZone);
  }
};

const parseDuration = (value: string): number | undefined => {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u.exec(
    value.trim(),
  );
  if (match === null) return undefined;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const ms =
    ((((Number(weeks ?? 0) * 7 + Number(days ?? 0)) * 24 + Number(hours ?? 0)) * 60 +
      Number(minutes ?? 0)) *
      60 +
      Number(seconds ?? 0)) *
    1000;
  return sign === "-" ? -ms : ms;
};

const parseRule = (value: string) =>
  new Map(
    value.split(";").map((part) => {
      const separator = part.indexOf("=");
      return [part.slice(0, separator).toUpperCase(), part.slice(separator + 1)] as const;
    }),
  );

const parseEvent = (properties: ReadonlyArray<Property>, self: string | null): VEvent | null => {
  const get = (name: string) => properties.find((property) => property.name === name);
  const time = (property: Property | undefined) =>
    property === undefined ? null : parseTime(property.value, property.params.get("TZID"));
  const start = time(get("DTSTART"));
  if (start === null) return null;
  const duration = get("DURATION");
  const rrule = get("RRULE");
  const textFields = ["X-GOOGLE-CONFERENCE", "LOCATION", "DESCRIPTION", "URL"].map((name) =>
    unescapeText(get(name)?.value ?? ""),
  );
  return {
    uid: get("UID")?.value ?? "",
    title: unescapeText(get("SUMMARY")?.value ?? "").trim() || "Busy",
    start,
    end: time(get("DTEND")) ?? undefined,
    durationMs: duration === undefined ? undefined : parseDuration(duration.value),
    rrule: rrule === undefined ? undefined : parseRule(rrule.value),
    exdates: properties
      .filter((property) => property.name === "EXDATE")
      .flatMap((property) =>
        property.value
          .split(",")
          .map((value) => parseTime(value, property.params.get("TZID")))
          .filter((value) => value !== null),
      ),
    recurrenceId: time(get("RECURRENCE-ID")) ?? undefined,
    cancelled: get("STATUS")?.value.toUpperCase() === "CANCELLED",
    declined:
      self !== null &&
      properties.some(
        (property) =>
          property.name === "ATTENDEE" &&
          property.value.toLowerCase() === `mailto:${self}` &&
          property.params.get("PARTSTAT")?.toUpperCase() === "DECLINED",
      ),
    joinUrl: textFields.map((text) => JOIN_URL.exec(text)?.[0]).find(Boolean) ?? null,
  };
};

/** Start days of a rule's occurrences, in order, from the series' first day. */
function* ruleDays(rule: ReadonlyMap<string, string>, firstDay: number): Generator<number> {
  const frequency = rule.get("FREQ")?.toUpperCase();
  const interval = Math.max(1, Number(rule.get("INTERVAL") ?? 1));
  const byDay = (rule.get("BYDAY") ?? "")
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/u.exec(entry.toUpperCase());
      return match === null
        ? null
        : {
            ordinal: match[1] === undefined ? null : Number(match[1]),
            weekday: WEEKDAYS.indexOf(match[2] as (typeof WEEKDAYS)[number]),
          };
    })
    .filter((entry) => entry !== null);
  const byMonthDay = (rule.get("BYMONTHDAY") ?? "").split(",").filter(Boolean).map(Number);
  const first = dayParts(firstDay);

  if (frequency === "DAILY") {
    for (let period = 0, day = firstDay; period < MAX_RULE_PERIODS; period++, day += interval) {
      if (byDay.length === 0 || byDay.some((entry) => entry.weekday === weekdayOf(day))) yield day;
    }
  }

  if (frequency === "WEEKLY") {
    const weekStart = WEEKDAYS.indexOf(
      (rule.get("WKST")?.toUpperCase() ?? "MO") as (typeof WEEKDAYS)[number],
    );
    const weekdays =
      byDay.length === 0 ? [weekdayOf(firstDay)] : byDay.map((entry) => entry.weekday);
    const offsets = weekdays
      .map((weekday) => (weekday - weekStart + 7) % 7)
      .toSorted((a, b) => a - b);
    const firstWeek = firstDay - ((weekdayOf(firstDay) - weekStart + 7) % 7);
    for (
      let period = 0, week = firstWeek;
      period < MAX_RULE_PERIODS;
      period++, week += 7 * interval
    ) {
      for (const offset of offsets) {
        if (week + offset >= firstDay) yield week + offset;
      }
    }
  }

  if (frequency === "MONTHLY" || frequency === "YEARLY") {
    const monthStep = frequency === "MONTHLY" ? interval : 12 * interval;
    for (let period = 0, index = 0; period < MAX_RULE_PERIODS; period++, index += monthStep) {
      const year = first.year + Math.floor((first.month - 1 + index) / 12);
      const month = ((first.month - 1 + index) % 12) + 1;
      const monthFirst = dayNumber(year, month, 1);
      const monthLength = dayNumber(year, month + 1, 1) - monthFirst;
      const days = new Set<number>();
      if (byMonthDay.length > 0) {
        for (const monthDay of byMonthDay) {
          const date = monthDay > 0 ? monthDay : monthLength + monthDay + 1;
          if (date >= 1 && date <= monthLength) days.add(monthFirst + date - 1);
        }
      } else if (byDay.length > 0) {
        for (const { ordinal, weekday } of byDay) {
          const matches = Array.from(
            { length: monthLength },
            (_, offset) => monthFirst + offset,
          ).filter((day) => weekdayOf(day) === weekday);
          if (ordinal === null) matches.forEach((day) => days.add(day));
          else {
            const day = ordinal > 0 ? matches[ordinal - 1] : matches[matches.length + ordinal];
            if (day !== undefined) days.add(day);
          }
        }
      } else if (first.day <= monthLength) {
        days.add(monthFirst + first.day - 1);
      }
      for (const day of [...days].toSorted((a, b) => a - b)) {
        if (day >= firstDay) yield day;
      }
    }
  }
}

const ruleEndOf = (rule: ReadonlyMap<string, string>, defaultZone: string | undefined) => {
  const until = rule.get("UNTIL");
  const parsed = until === undefined ? null : parseTime(until, undefined);
  if (parsed === null) return Infinity;
  // A date-only UNTIL includes that whole day.
  return parsed.kind === "date"
    ? resolve({ kind: "date", day: parsed.day + 1 }, defaultZone) - 1
    : resolve(parsed, defaultZone);
};

/** Starts of the event's occurrences that can overlap `[from, until)`. */
const occurrenceStarts = (
  event: VEvent,
  defaultZone: string | undefined,
  from: number,
  until: number,
): ReadonlyArray<number> => {
  const start = resolve(event.start, defaultZone);
  if (event.rrule === undefined) return [start];
  const count = event.rrule.has("COUNT") ? Number(event.rrule.get("COUNT")) : Infinity;
  const ruleEnd = ruleEndOf(event.rrule, defaultZone);
  const eventStart = event.start;
  const firstDay =
    eventStart.kind === "instant"
      ? Math.floor(start / DAY_MS)
      : eventStart.kind === "date"
        ? eventStart.day
        : eventStart.wall.day;
  // Exact for UTC series, within a day otherwise; cheap enough for years of history.
  const roughStart = (day: number) =>
    eventStart.kind === "wall"
      ? day * DAY_MS + wallOffsetMs(eventStart.wall)
      : day * DAY_MS + (start - firstDay * DAY_MS);
  const exactStart = (day: number) =>
    eventStart.kind === "wall"
      ? resolveWall({ ...eventStart.wall, day }, eventStart.timeZone ?? defaultZone)
      : day === firstDay
        ? start
        : eventStart.kind === "date"
          ? resolve({ kind: "date", day }, defaultZone)
          : roughStart(day);
  const margin = 2 * DAY_MS;

  const starts: number[] = [];
  let produced = 0;
  for (const day of ruleDays(event.rrule, firstDay)) {
    if (produced >= count) break;
    const rough = roughStart(day);
    if (rough - margin >= Math.min(until, ruleEnd)) break;
    const nearWindow = rough + margin >= from || rough + margin >= ruleEnd;
    const occurrence = nearWindow ? exactStart(day) : rough;
    if (occurrence > ruleEnd || occurrence >= until) break;
    produced++;
    if (nearWindow) starts.push(occurrence);
  }
  return starts;
};

/**
 * Timed events in a Google Calendar iCal feed that overlap `[from, to)`, soonest first.
 * All-day events, cancelled events and events `self` declined are left out.
 */
export const occurrencesBetween = (
  ics: string,
  from: number,
  to: number,
): ReadonlyArray<CalendarOccurrence> => {
  const lines = unfold(ics)
    .map(parseLine)
    .filter((line) => line !== null);
  const calendarZone = lines.find((line) => line.name === "X-WR-TIMEZONE")?.value;
  const calendarName = lines.find((line) => line.name === "X-WR-CALNAME")?.value ?? "";
  const self = calendarName.includes("@") ? calendarName.toLowerCase() : null;

  const events: VEvent[] = [];
  let current: Property[] | null = null;
  let depth = 0;
  for (const line of lines) {
    if (line.name === "BEGIN" && line.value.toUpperCase() === "VEVENT") {
      current = [];
      depth = 0;
    } else if (current !== null && line.name === "BEGIN") depth++;
    else if (current !== null && line.name === "END" && depth > 0) depth--;
    else if (current !== null && line.name === "END" && line.value.toUpperCase() === "VEVENT") {
      const event = parseEvent(current, self);
      if (event !== null) events.push(event);
      current = null;
    } else if (current !== null && depth === 0) current.push(line);
  }

  const overrides = new Map<string, Set<number>>();
  for (const event of events) {
    if (event.recurrenceId === undefined) continue;
    const moved = overrides.get(event.uid) ?? new Set<number>();
    moved.add(resolve(event.recurrenceId, calendarZone));
    overrides.set(event.uid, moved);
  }

  const occurrences: CalendarOccurrence[] = [];
  for (const event of events) {
    if (event.start.kind === "date" || event.cancelled || event.declined) continue;
    const start = resolve(event.start, calendarZone);
    const length =
      event.end !== undefined ? resolve(event.end, calendarZone) - start : (event.durationMs ?? 0);
    const skipped = new Set([
      ...event.exdates.map((time) => resolve(time, calendarZone)),
      ...(event.recurrenceId === undefined ? (overrides.get(event.uid) ?? []) : []),
    ]);
    for (const startsAt of occurrenceStarts(event, calendarZone, from - length, to)) {
      if (skipped.has(startsAt) || startsAt + length <= from) continue;
      occurrences.push({
        title: event.title,
        startsAt,
        endsAt: startsAt + length,
        joinUrl: event.joinUrl,
      });
    }
  }
  return occurrences.toSorted((a, b) => a.startsAt - b.startsAt);
};
