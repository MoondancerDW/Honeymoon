export const CHAT_TEXT_LIMIT = 512;
export const CHAT_RETENTION_MS = 4 * 60 * 60 * 1000;

export function limitChatText(text) {
  if (text.length <= CHAT_TEXT_LIMIT) return text;
  let count = 0;
  let end = 0;
  for (const character of text) {
    if (count === CHAT_TEXT_LIMIT) return text.slice(0, end);
    count++;
    end += character.length;
  }
  return text;
}
