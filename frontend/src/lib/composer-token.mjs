// Parse at the selection, not at the end of the draft. Fullwidth punctuation
// comes from Chinese keyboards; emails and ordinary paths are not triggers.
export function composerToken(value, caret = value.length, selectionEnd = caret) {
  if (caret !== selectionEnd) return null;
  const before = value.slice(0, caret);
  const slash = before.match(/(?:^|\n)[\t ]*[/／]([a-z]*)$/i);
  const at = before.match(/(?:^|[^a-z\d._%+\-])[@＠]([^\s@＠]*)$/i);
  const match = slash || at;
  if (!match) return null;
  const tail = value.slice(caret).match(slash ? /^[a-z]*/i : /^[^\s@＠]*/)[0];
  return { kind: slash ? 'slash' : 'at', query: slash ? '/' + match[1].toLowerCase() : match[1],
    start: caret - match[1].length - 1, end: caret + tail.length };
}
export function removeComposerToken(value, token) {
  return token ? value.slice(0, token.start) + value.slice(token.end) : value;
}
