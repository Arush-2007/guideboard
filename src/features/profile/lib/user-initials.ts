/**
 * First letters of the first and last word of a name ("Ada Lovelace" -> "AL"),
 * falling back to the email's first character so an avatar is never an empty
 * circle. Lives apart from `<UserAvatar>` so it can be tested without a DOM.
 */
export function userInitials(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return (email.trim()[0] ?? "?").toUpperCase();
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
