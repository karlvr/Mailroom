import { randomToken } from "./crypto";
import { htmlToText } from "./mime";

// Types and helpers for the Google Calendar API. Each type has only the fields that Mailroom uses.

/** The start or the end of an event. An all-day event has `date`, and a timed event has `dateTime`. */
export interface EventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface EventPerson {
  email?: string;
  displayName?: string;
  /** True when this person is the account that Mailroom uses. */
  self?: boolean;
}

export interface EventAttendee extends EventPerson {
  organizer?: boolean;
  /** True when the attendee is a room or another resource, not a person. */
  resource?: boolean;
  optional?: boolean;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  comment?: string;
}

export interface CalendarEvent {
  id: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  /** The ID of the recurring event that this event is one instance of. */
  recurringEventId?: string;
  recurrence?: string[];
  organizer?: EventPerson;
  creator?: EventPerson;
  attendees?: EventAttendee[];
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  attachments?: { title?: string }[];
  created?: string;
  updated?: string;
}

export interface CalendarListEntry {
  id: string;
  summary?: string;
  /** The name that the user gave to the calendar in their own list. */
  summaryOverride?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
  hidden?: boolean;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Returns the event time for a value from Claude. A date such as `2026-11-10` makes an all-day time.
 * Any other value is a date-time, which Google validates.
 */
export function toEventTime(value: string, timeZone?: string): EventTime {
  return DATE_ONLY.test(value) ? { date: value } : { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

/** Returns the attendees that are other people: not the account itself and not a room or another resource. */
export function otherGuests(attendees: EventAttendee[] | undefined, accountEmail: string): EventAttendee[] {
  const self = accountEmail.toLowerCase();
  return (attendees ?? []).filter((a) => !a.self && !a.resource && (a.email ?? "").toLowerCase() !== self);
}

/**
 * Returns a new attendee list with the guests in `add` added and the guests in `remove` removed.
 * It compares email addresses without case, keeps the other attendees unchanged, and adds no duplicates.
 */
export function changeGuests(
  attendees: EventAttendee[] | undefined,
  changes: { add: string[]; remove: string[] },
): EventAttendee[] {
  const key = (email: string | undefined) => (email ?? "").toLowerCase();
  const remove = new Set(changes.remove.map(key));
  const result = (attendees ?? []).filter((a) => !remove.has(key(a.email)));
  for (const email of changes.add) {
    if (!result.some((a) => key(a.email) === key(email))) result.push({ email });
  }
  return result;
}

/** Returns true when the account is a guest of the event and not its organizer. */
export function isGuest(e: CalendarEvent): boolean {
  return !e.organizer?.self && !!e.attendees?.some((a) => a.self);
}

/** Returns the conference data that makes Google add a new Google Meet link to an event. */
export function newMeetConference() {
  return { createRequest: { requestId: randomToken(12), conferenceSolutionKey: { type: "hangoutsMeet" } } };
}

const meetLink = (e: CalendarEvent) =>
  e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? null;

export function summariseEvent(e: CalendarEvent) {
  return {
    event_id: e.id,
    recurring_event_id: e.recurringEventId ?? null,
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    all_day: !!e.start?.date,
    location: e.location ?? null,
    status: e.status ?? null,
    organizer: e.organizer?.email ?? null,
    my_response: e.attendees?.find((a) => a.self)?.responseStatus ?? null,
    guest_count: (e.attendees ?? []).filter((a) => !a.resource).length,
    meet_link: meetLink(e),
    html_link: e.htmlLink ?? null,
  };
}

/** Returns all the details of an event. The description is plain text of at most `maxChars` characters. */
export function describeEvent(e: CalendarEvent, maxChars: number) {
  // Google Calendar saves HTML descriptions, but other apps can save plain text.
  const raw = e.description ?? "";
  const text = /<[a-z][^>]*>/i.test(raw) ? htmlToText(raw) : raw.trim();
  return {
    ...summariseEvent(e),
    description: text.length > maxChars ? text.slice(0, maxChars) + "\n…[truncated]" : text,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email ?? null,
      name: a.displayName ?? null,
      response: a.responseStatus ?? null,
      comment: a.comment ?? null,
      optional: a.optional === true,
      organizer: a.organizer === true,
      room: a.resource === true,
      self: a.self === true,
    })),
    recurrence: e.recurrence ?? null,
    attachments: (e.attachments ?? []).map((a) => a.title ?? ""),
    creator: e.creator?.email ?? null,
    created: e.created ?? null,
    updated: e.updated ?? null,
  };
}
