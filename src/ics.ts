// A small reader for iCalendar (RFC 5545) data, such as the invitation in an email. It reads the
// fields of each event that an agent needs to understand an invitation, and ignores the rest.

/** A person in an event: the organizer or a guest. */
export interface IcsPerson {
  email: string | null;
  name: string | null;
}

/** A guest of an event, with the reply of the guest. */
export interface IcsGuest extends IcsPerson {
  /** The PARTSTAT of the guest in lower case, for example "accepted" or "needs-action". */
  response: string | null;
}

/** One event of iCalendar data. */
export interface IcsEvent {
  /** The METHOD of the calendar, for example REQUEST for an invitation or CANCEL for a cancellation. */
  method: string | null;
  uid: string | null;
  /** The version of the event. A larger number replaces the earlier invitations of the event. */
  sequence: number | null;
  status: string | null;
  summary: string | null;
  location: string | null;
  /** A date such as 2026-11-12 for an all-day event, a UTC time that ends in Z, or a local time in `time_zone`. */
  start: string | null;
  end: string | null;
  /** The DURATION of an event without an end, for example PT1H. */
  duration?: string;
  /** The TZID of the start, when the start is a local time. */
  time_zone: string | null;
  all_day: boolean;
  /** The RRULE of a recurring event. */
  recurrence: string | null;
  /** For a change to one instance of a recurring event, the start of that instance in the series. */
  recurrence_id: string | null;
  organizer: IcsPerson | null;
  guests: IcsGuest[];
  /** The number of guests after the first MAX_GUESTS. */
  more_guests?: number;
}

// The largest number of guests of one event that the reader gives.
const MAX_GUESTS = 50;

/** One content line: the property name in upper case, its parameters, and its value. */
interface ContentLine {
  name: string;
  params: Map<string, string>;
  value: string;
}

/** Splits text at each `separator` that is not inside double quotes. */
function splitUnquoted(text: string, separator: string, limit = Infinity): string[] {
  const out: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length && out.length < limit - 1; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (text[i] === separator && !quoted) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** Returns the content line of one unfolded line, or null when the line has no value. */
function parseLine(line: string): ContentLine | null {
  const [head, value] = splitUnquoted(line, ":", 2);
  if (value === undefined) return null;
  const [name, ...params] = splitUnquoted(head!, ";");
  return {
    name: name!.trim().toUpperCase(),
    params: new Map(
      params.map((p) => {
        const at = p.indexOf("=");
        return [p.slice(0, at).trim().toUpperCase(), p.slice(at + 1).replace(/^"|"$/g, "")];
      }),
    ),
    value,
  };
}

/** Returns a TEXT value without its escapes. */
const unescape = (value: string) => value.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

/** Returns a CAL-ADDRESS without its mailto: prefix. */
const address = (value: string) => value.replace(/^mailto:/i, "").trim() || null;

/** Returns a DATE or DATE-TIME value in ISO form: 2026-11-12, 2026-11-12T09:00:00Z or 2026-11-12T09:00:00. */
function isoTime(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value.trim());
  if (!m) return value.trim();
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  return m[4] ? `${date}T${m[4]}:${m[5]}:${m[6]}${m[7]}` : date;
}

const person = (l: ContentLine): IcsPerson => ({ email: address(l.value), name: l.params.get("CN") ?? null });

/** Returns the events of iCalendar data. Data that is not iCalendar gives no events. */
export function parseIcs(text: string): IcsEvent[] {
  const lines = text
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .flatMap((l) => parseLine(l) ?? []);
  let method: string | null = null;
  const events: IcsEvent[] = [];
  // The components that contain the current line, for example VCALENDAR, VEVENT and VALARM.
  const open: string[] = [];
  let event: IcsEvent | null = null;
  for (const l of lines) {
    if (l.name === "BEGIN") {
      open.push(l.value.trim().toUpperCase());
      if (open[open.length - 1] === "VEVENT") {
        event = {
          method,
          uid: null,
          sequence: null,
          status: null,
          summary: null,
          location: null,
          start: null,
          end: null,
          time_zone: null,
          all_day: false,
          recurrence: null,
          recurrence_id: null,
          organizer: null,
          guests: [],
        };
      }
      continue;
    }
    if (l.name === "END") {
      if (open.pop() === "VEVENT" && event) {
        if (event.guests.length > MAX_GUESTS) {
          event.more_guests = event.guests.length - MAX_GUESTS;
          event.guests = event.guests.slice(0, MAX_GUESTS);
        }
        events.push(event);
        event = null;
      }
      continue;
    }
    const inside = open[open.length - 1];
    if (inside === "VCALENDAR" && l.name === "METHOD") method = l.value.trim().toUpperCase();
    if (inside !== "VEVENT" || !event) continue;
    switch (l.name) {
      case "UID":
        event.uid = l.value.trim();
        break;
      case "SEQUENCE":
        event.sequence = Number(l.value) || 0;
        break;
      case "STATUS":
        event.status = l.value.trim().toUpperCase();
        break;
      case "SUMMARY":
        event.summary = unescape(l.value);
        break;
      case "LOCATION":
        event.location = unescape(l.value);
        break;
      case "DTSTART":
        event.start = isoTime(l.value);
        event.time_zone = l.params.get("TZID") ?? null;
        event.all_day = l.params.get("VALUE")?.toUpperCase() === "DATE" || /^\d{8}$/.test(l.value.trim());
        break;
      case "DTEND":
        event.end = isoTime(l.value);
        break;
      case "DURATION":
        event.duration = l.value.trim();
        break;
      case "RRULE":
        event.recurrence = l.value.trim();
        break;
      case "RECURRENCE-ID":
        event.recurrence_id = isoTime(l.value);
        break;
      case "ORGANIZER":
        event.organizer = person(l);
        break;
      case "ATTENDEE":
        event.guests.push({ ...person(l), response: l.params.get("PARTSTAT")?.toLowerCase() ?? null });
        break;
    }
  }
  // The method comes before the events in valid data, but some senders put it after them.
  return events.map((e) => ({ ...e, method: e.method ?? method }));
}
