import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";

export const CALENDAR_METHODS = {
  setFeed: "mods.calendar.setFeed",
  subscribe: "mods.calendar.subscribe",
} as const;

export const CalendarEvent = Schema.Struct({
  title: Schema.String,
  startsAt: Schema.DateTimeUtc,
  endsAt: Schema.DateTimeUtc,
  joinUrl: Schema.NullOr(Schema.String),
});
export type CalendarEvent = typeof CalendarEvent.Type;

export const CalendarStatus = Schema.Struct({
  /** Whether an iCal link is saved on the server. */
  configured: Schema.Boolean,
  /** Timed events overlapping the next 24 hours, soonest first. */
  events: Schema.Array(CalendarEvent),
  /** Why the last read of the saved link failed. */
  error: Schema.NullOr(Schema.String),
});
export type CalendarStatus = typeof CalendarStatus.Type;

export class CalendarFeedError extends Schema.TaggedError<CalendarFeedError>()(
  "CalendarFeedError",
  { message: Schema.String },
) {}

export const CalendarSetFeedRpc = Rpc.make(CALENDAR_METHODS.setFeed, {
  payload: Schema.Struct({ url: Schema.NullOr(Schema.String) }),
  error: Schema.Union([CalendarFeedError, EnvironmentAuthorizationError]),
});

export const CalendarSubscribeRpc = Rpc.make(CALENDAR_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: CalendarStatus,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const CALENDAR_RPC_SCOPES = {
  [CALENDAR_METHODS.setFeed]: AuthSettingsWriteScope,
  [CALENDAR_METHODS.subscribe]: AuthOrchestrationReadScope,
} as const;
