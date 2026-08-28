import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const GROUP_ID = /^\d{8,32}-\d{1,12}@g\.us$/;
const DIRECT_ID = /^\d{7,15}@s\.whatsapp\.net$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,48}$/;
const MODEL = /^[a-z0-9][a-z0-9._/-]{0,199}$/i;

export async function loadConfig(path = process.env.GOVORUN_CONFIG || "/etc/govorun/groups.json") {
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { throw new Error(`cannot read Govorun configuration: ${error.message}`); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Govorun configuration is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.groups)) {
    throw new Error("Govorun configuration requires a groups array");
  }
  if (parsed.groups.length > 32) throw new Error("Govorun supports at most 32 configured groups");
  if (parsed.direct !== undefined && !Array.isArray(parsed.direct)) throw new Error("direct must be an array");
  if ((parsed.direct || []).length > 16) throw new Error("Govorun supports at most 16 configured direct chats");
  const groups = new Map();
  const directChats = new Map();
  for (const group of parsed.groups) {
    if (!group || typeof group !== "object" || !GROUP_ID.test(group.id || "") || !SLUG.test(group.slug || "")) {
      throw new Error("each Govorun group needs a valid WhatsApp group id and slug");
    }
    if (groups.has(group.id)) throw new Error("Govorun group ids must be unique");
    const workspace = resolve("/home/govorun/groups", group.slug);
    if (!workspace.startsWith("/home/govorun/groups/")) throw new Error("invalid Govorun group workspace");
    groups.set(group.id, Object.freeze({ id: group.id, slug: group.slug, workspace }));
  }
  for (const chat of parsed.direct || []) {
    if (!chat || typeof chat !== "object" || !DIRECT_ID.test(chat.id || "") || !SLUG.test(chat.slug || "")) {
      throw new Error("each direct chat needs a valid WhatsApp user id and slug");
    }
    if (directChats.has(chat.id)) throw new Error("direct chat ids must be unique");
    const workspace = resolve("/home/govorun/direct", chat.slug);
    if (!workspace.startsWith("/home/govorun/direct/")) throw new Error("invalid Govorun direct workspace");
    directChats.set(chat.id, Object.freeze({ id: chat.id, slug: chat.slug, workspace }));
  }
  const primary = parsed.models?.primary || "openai-codex/gpt-5.6-luna";
  const fallback = parsed.models?.fallback || "venice/z-ai-glm-5-3-flash";
  if (!MODEL.test(primary) || !MODEL.test(fallback)) throw new Error("invalid Govorun model identifier");
  return Object.freeze({
    groups,
    directChats,
    models: Object.freeze({ primary, fallback, thinking: "high" }),
    sessionMinAgeMs: 72 * 60 * 60 * 1000,
    inactivityResetMs: 6 * 60 * 60 * 1000,
    voiceWindowMs: 5 * 60 * 1000,
  });
}
