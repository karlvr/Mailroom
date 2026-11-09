// A word diff for short texts, such as the context notes of a mailbox.

/** One run of a diff: text that both versions have, or text that only the old or the new version has. */
export interface DiffRun {
  op: "same" | "removed" | "added";
  text: string;
}

/** The largest product of the token counts of the two texts that `diffWords` compares word by word. */
const MAX_CELLS = 9_000_000;

/** Splits a text into words and runs of white space, so that the tokens join back into the text. */
const tokenize = (text: string): string[] => text.match(/\s+|\S+/g) ?? [];

/** Returns the runs that turn `before` into `after`. Use it for texts of a few thousand words or fewer. */
export function diffWords(before: string, after: string): DiffRun[] {
  let a = tokenize(before);
  let b = tokenize(after);

  // A typical edit changes a small part, so compare only the part between the common start and end.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const runs: DiffRun[] = [];
  const push = (op: DiffRun["op"], text: string) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last?.op === op) last.text += text;
    else runs.push({ op, text });
  };
  push("same", a.slice(0, start).join(""));
  const tail = a.slice(a.length - end).join("");
  a = a.slice(start, a.length - end);
  b = b.slice(start, b.length - end);

  if (a.length * b.length > MAX_CELLS) {
    // Too large for a word diff: show the changed part as removed and added.
    push("removed", a.join(""));
    push("added", b.join(""));
  } else {
    // The length of the longest common subsequence of a[i..] and b[j..], in a table of (n+1) × (m+1).
    // MAX_CELLS keeps each length below 2^16.
    const n = a.length;
    const m = b.length;
    const lcs = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] =
          a[i] === b[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        push("same", a[i++]);
        j++;
      } else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) {
        push("removed", a[i++]);
      } else {
        push("added", b[j++]);
      }
    }
    while (i < n) push("removed", a[i++]);
    while (j < m) push("added", b[j++]);
  }
  push("same", tail);
  return runs;
}
