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
    date: "2026-11-12",
    changes: [
      "Agents can keep notes between runs, such as when the last briefing ran or which threads already got an update, so they no longer rebuild this from labels.",
      "An agent can read attachments: text and log files, calendar files, and PDF, Word and Excel documents, for example to find the amount and due date of an invoice.",
      "An agent can read the details of an invitation in an email, from Google, Outlook or iCloud: the time, the organizer and who accepted.",
      "An agent can find the calendar events that are new, moved or cancelled since it last checked, also invitations from Outlook and iCloud that Google Calendar added.",
      "An agent can delete drafts. It still cannot delete email that you received or sent.",
      "An agent can find and edit drafts, so a change to a reply no longer leaves an old copy behind.",
      "An agent can limit a bulk clean-up to mail you have already read, or to mail older than a number of days. By default, bulk trash leaves out starred threads and conversations that you wrote in.",
      "An agent can search or summarise all your mailboxes in one step, for example to find every email from one sender.",
      "An agent can summarise a mailbox in one step: how many threads match a search, how many are unread, and which senders, lists or subjects they come from.",
    ],
  },
  {
    date: "2026-11-10",
    changes: [
      "A new setting for each mailbox, Allow replies, lets agents reply or reply to all, but not send new email or add people. Allow sending email includes replies.",
      "An agent can label, archive or trash many threads at once: give a list of threads, or a Gmail search such as all the failure reports from one service. The agent first gets a preview with the subject of each thread, and the change happens only when it confirms that preview.",
      "The Mailboxes page shows when an agent last used each mailbox, and how many calls and changes agents made in the last 7 days.",
      "You can connect Claude Code, Codex and ChatGPT, as well as Claude. The Connect an agent page has the steps.",
      "The Mailboxes page shows each mailbox that still needs a name and context notes.",
      "The Mailboxes page tells you when an agent must reconnect to get new tools.",
      "An agent can tell you what changed, from these release notes.",
      "You can write a global context with notes that apply to every mailbox.",
      "An agent can propose changes to a context. You accept, edit or reject each proposal.",
      "Each context keeps a history, so you can compare and restore earlier versions.",
      "An agent can forward an email, with its attachments, as a draft.",
      "Two new settings for each mailbox let agents send calendar invitations and RSVP to invitations.",
      "An agent can read your Google Calendar, find free time, and create and change events. To add the calendar to a mailbox, click Re-link.",
    ],
  },
  {
    date: "2026-11-09",
    changes: ["First release: Claude can work in all your Gmail and Google Workspace mailboxes, and each mailbox has its own context."],
  },
];
