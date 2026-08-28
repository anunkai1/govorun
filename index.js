import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  getContentType,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import QRCode from "qrcode";
import { loadConfig } from "./lib/config.js";
import { GroupAgent } from "./lib/pi.js";
import { speakAsWhatsappVoice, transcribeVoice } from "./lib/voice.js";

const AUTH_DIR = "/home/govorun/.local/state/govorun/whatsapp-auth";
const STATE_DIR = "/home/govorun/.local/state/govorun";
const QR_PATH = join(STATE_DIR, "whatsapp-link.txt");
const QR_PNG_PATH = join(STATE_DIR, "whatsapp-link.png");
const RECENT_LIMIT = 4096;
const YOUTUBE = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s]*\bv=|shorts\/|live\/)|youtu\.be\/)[^\s<>()]+/i;

let config = await loadConfig();
const agents = new Map();
const serialTails = new Map();
const recentMessages = new Set();
const recentOrder = [];
const pendingVoice = new Map();
let socket;
let botJid;
let reconnectTimer;
let stopping = false;

function log(message) { console.log(`[govorun] ${message}`); }
function shortError(error) { return String(error?.message || error).replace(/[\r\n]+/g, " ").slice(0, 500); }

function remember(id) {
  if (!id || recentMessages.has(id)) return false;
  recentMessages.add(id);
  recentOrder.push(id);
  if (recentOrder.length > RECENT_LIMIT) recentMessages.delete(recentOrder.shift());
  return true;
}

function serialise(groupId, task) {
  const previous = serialTails.get(groupId) || Promise.resolve();
  const tail = previous.catch(() => {}).then(task);
  serialTails.set(groupId, tail);
  return tail.finally(() => { if (serialTails.get(groupId) === tail) serialTails.delete(groupId); });
}

async function agentFor(group) {
  let agent = agents.get(group.id);
  if (!agent) {
    agent = new GroupAgent(group, config);
    await agent.initialise();
    agents.set(group.id, agent);
  }
  return agent;
}

function messageParts(raw) {
  const message = normalizeMessageContent(raw.message);
  const type = getContentType(message);
  const content = type ? message?.[type] : undefined;
  if (!type || !content) return { type: null, content: null, text: "", mentions: [] };
  const text = typeof message.conversation === "string" ? message.conversation :
    typeof content.text === "string" ? content.text : typeof content.caption === "string" ? content.caption : "";
  const mentions = Array.isArray(content.contextInfo?.mentionedJid) ? content.contextInfo.mentionedJid : [];
  return { type, content, text, mentions };
}

function isMentioned(mentions) {
  return Boolean(botJid && mentions.some((value) => jidNormalizedUser(value) === botJid));
}

function isNewCommand(text) { return /(^|\s)\/new(?:\s|$)/i.test(text); }
function isListenCommand(text) { return /(^|\s)listen(?:\s|$)/i.test(text.replace(/@\S+/g, "").trim()); }
function voiceKey(groupId, sender) { return `${groupId}\u0000${sender}`; }

async function sendText(groupId, text, quoted) {
  return socket.sendMessage(groupId, { text: text.slice(0, 60_000) }, quoted ? { quoted } : undefined);
}

async function replyWithResult(groupId, original, result, voice) {
  await sendText(groupId, result, original);
  if (!voice) return;
  try {
    const audio = await speakAsWhatsappVoice(result);
    await socket.sendMessage(groupId, {
      audio,
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
    }, { quoted: original });
  } catch (error) {
    log(`voice reply failed: ${shortError(error)}`);
  }
}

async function handleMessage(raw) {
  const groupId = raw.key?.remoteJid;
  if (!groupId || raw.key?.fromMe || !config.groups.has(groupId) || !remember(raw.key?.id)) return;
  const group = config.groups.get(groupId);
  const sender = raw.key.participant || raw.key.remoteJid;
  const { type, text, mentions } = messageParts(raw);
  const mentioned = isMentioned(mentions);
  const youtube = YOUTUBE.test(text);
  const pendingKey = voiceKey(groupId, sender);
  const pendingUntil = pendingVoice.get(pendingKey) || 0;
  const voice = type === "audioMessage" && raw.message && pendingUntil > Date.now();
  if (!mentioned && !youtube && !voice) return;

  await serialise(groupId, async () => {
    const agent = await agentFor(group);
    if (mentioned && isListenCommand(text)) {
      pendingVoice.set(pendingKey, Date.now() + config.voiceWindowMs);
      await sendText(groupId, "Send your voice note now.", raw);
      return;
    }
    if (mentioned && isNewCommand(text)) {
      await agent.reset();
      await sendText(groupId, "New Govorun session started.", raw);
      return;
    }

    let request = text.trim();
    let shouldVoiceReply = false;
    if (voice) {
      pendingVoice.delete(pendingKey);
      try {
        const audio = await downloadMediaMessage(raw, "buffer", {}, { reuploadRequest: socket.updateMediaMessage });
        request = await transcribeVoice(audio);
        shouldVoiceReply = true;
      } catch (error) {
        await sendText(groupId, `I couldn't transcribe that voice note: ${shortError(error)}`, raw);
        return;
      }
    }
    if (!request && !youtube) return;
    const prefix = youtube && !mentioned
      ? "A YouTube link was posted in this approved Govorun group. Analyse its transcript accurately and summarise only transcript-supported information. If no transcript is available, say so plainly.\n\n"
      : "";
    try {
      const result = await agent.prompt(`${prefix}${request}`);
      await replyWithResult(groupId, raw, result, shouldVoiceReply || /reply\s+(?:in\s+)?voice/i.test(request));
    } catch (error) {
      await sendText(groupId, `Govorun could not complete that request: ${shortError(error)}`, raw);
    }
  });
}

async function connect() {
  if (stopping) return;
  await mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  socket = makeWASocket({ auth: state, markOnlineOnConnect: false, syncFullHistory: false, generateHighQualityLinkPreview: false });
  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("connection.update", async (update) => {
    if (update.qr) {
      const terminal = await QRCode.toString(update.qr, { type: "terminal", small: true });
      await writeFile(QR_PATH, terminal, { mode: 0o600 });
      await QRCode.toFile(QR_PNG_PATH, update.qr, { width: 900, margin: 2 });
      await chmod(QR_PNG_PATH, 0o600);
      log(`WhatsApp link QR is ready at ${QR_PATH}; scan it from the dedicated Govorun phone.`);
    }
    if (update.connection === "open") {
      botJid = jidNormalizedUser(socket.user?.id || "");
      log(`WhatsApp connected as ${botJid}; configured groups=${config.groups.size}`);
    }
    if (update.connection === "close" && !stopping) {
      const status = update.lastDisconnect?.error?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        log("WhatsApp logged out; remove the auth state and re-link from the Govorun phone.");
        return;
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connect().catch((error) => log(`reconnect failed: ${shortError(error)}`)), 3_000);
    }
  });
  socket.ev.on("messages.upsert", ({ messages }) => {
    for (const message of messages) handleMessage(message).catch((error) => log(`message failed: ${shortError(error)}`));
  });
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(reconnectTimer);
  for (const agent of agents.values()) agent.stop();
  try { socket?.end?.(new Error("Govorun stopping")); } catch {}
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", async () => {
  try { config = await loadConfig(); log(`configuration reloaded; configured groups=${config.groups.size}`); }
  catch (error) { log(`configuration reload failed: ${shortError(error)}`); }
});

log(`starting; configured groups=${config.groups.size}; instance=${randomUUID().slice(0, 8)}`);
connect().catch((error) => { console.error(`[govorun] startup failed: ${shortError(error)}`); process.exitCode = 1; });
