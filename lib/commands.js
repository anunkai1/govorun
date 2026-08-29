/** Match the explicit command that arms the next voice-note window. */
export function isListenCommand(text) {
  const withoutMentions = String(text || "").replace(/@\S+/g, "").trim();
  return /^listen[.!]?$/i.test(withoutMentions);
}
