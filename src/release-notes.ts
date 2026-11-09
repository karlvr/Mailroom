/** The changes of one day. */
export interface ReleaseDay {
  /** The day, as YYYY-MM-DD. */
  date: string;
  /** One short sentence for each change, in plain text, newest change first. */
  changes: string[];
}

/**
 * The changes to Mailroom that a person who uses it needs to know about, newest day first: a new
 * ability, a new setting, or an action that the person or the admin must do. Design changes,
 * changes that a person does not notice, and internal changes are not in the list. Each change is
 * one short sentence that an agent can read out to the user.
 */
// Add a change in the same commit as the change. Put all the changes of one day under one date.
export const RELEASE_NOTES: ReleaseDay[] = [
  {
    date: "2026-11-10",
    changes: [
      "The Mailboxes page tells you when Claude must reconnect to get new tools.",
      "Claude can tell you what changed, from these release notes.",
      "You can write a global context with notes that apply to every mailbox.",
      "Claude can propose changes to a context. You accept, edit or reject each proposal.",
      "Each context keeps a history, so you can compare and restore earlier versions.",
      "Claude can forward an email, with its attachments, as a draft.",
      "Two new settings for each mailbox let Claude send calendar invitations and reply to invitations.",
      "Claude can read your Google Calendar, find free time, and create and change events. To add the calendar to a mailbox, click Re-link.",
    ],
  },
  {
    date: "2026-11-09",
    changes: ["First release: Claude can work in all your Gmail and Google Workspace mailboxes, and each mailbox has its own context."],
  },
];
