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
import pino from "pino";
import { loadConfig } from "./lib/config.js";
import { GroupAgent } from "./lib/pi.js";
import { drainOutgoingFiles } from "./lib/outbox.js";
import { saveIncomingAttachment } from "./lib/inbox.js";
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
let botJids = new Set();
let reconnectTimer;
let stopping = false;
let reloadRequested = false;
let restarting = false;

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
  return mentions.some((value) => botJids.has(jidNormalizedUser(value)));
}

function isNewCommand(text) { return /(^|\s)\/new(?:\s|$)/i.test(text); }
function isListenCommand(text) { return /(^|\s)listen(?:\s|$)/i.test(text.replace(/@\S+/g, "").trim()); }
function voiceKey(groupId, sender) { return `${groupId}\u0000${sender}`; }

async function sendText(groupId, text, quoted) {
  return socket.sendMessage(groupId, { text: text.slice(0, 60_000) }, quoted ? { quoted } : undefined);
}

function startPresence(groupId, kind) {
  let stopped = false;
  const pulse = () => { if (!stopped) socket.sendPresenceUpdate(kind, groupId).catch(() => {}); };
  pulse();
  const timer = setInterval(pulse, 12_000);
  timer.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.sendPresenceUpdate("paused", groupId).catch(() => {});
  };
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
  if (!groupId || raw.key?.fromMe || !remember(raw.key?.id)) return;
  const directId = jidNormalizedUser(groupId);
  const direct = config.directChats.get(directId);
  const group = config.groups.get(groupId) || direct;
  if (!group) {
    if (groupId.endsWith("@s.whatsapp.net") || groupId.endsWith("@lid")) log(`ignored unconfigured direct chat ${directId}`);
    return;
  }
  const isDirect = Boolean(direct);
  const sender = raw.key.participant || raw.key.remoteJid;
  const { type, content, text, mentions } = messageParts(raw);
  const mentioned = isMentioned(mentions);
  const youtube = YOUTUBE.test(text);
  const pendingKey = voiceKey(groupId, sender);
  const pendingUntil = pendingVoice.get(pendingKey) || 0;
  const voice = type === "audioMessage" && raw.message && pendingUntil > Date.now();
  if (!isDirect && !mentioned && !youtube && !voice) return;
  try { await socket.readMessages([raw.key]); } catch {}

  await serialise(groupId, async () => {
    const stopPresence = startPresence(groupId, type === "audioMessage" ? "recording" : "composing");
    try {
      const agent = await agentFor(group);
      if ((mentioned || isDirect) && isListenCommand(text)) {
        pendingVoice.set(pendingKey, Date.now() + config.voiceWindowMs);
        await sendText(groupId, "Теперь отправьте голосовое сообщение.", raw);
        return;
      }
      if ((mentioned || isDirect) && isNewCommand(text)) {
        await agent.reset();
        await sendText(groupId, "Новая сессия Говоруна начата.", raw);
        return;
      }

      let attachment;
      try {
        attachment = await saveIncomingAttachment(raw, group, type, content, () =>
          downloadMediaMessage(raw, "buffer", {}, { reuploadRequest: socket.updateMediaMessage }));
      } catch (error) {
        await sendText(groupId, `Не удалось получить вложение: ${shortError(error)}`, raw);
        return;
      }
      let request = text.trim();
      let shouldVoiceReply = false;
      if (attachment) {
        request = [request, `A WhatsApp attachment was received. Inspect this file and use it to fulfil the request: ${attachment.path}`]
          .filter(Boolean).join("\n\n");
      }
      if (voice) {
        pendingVoice.delete(pendingKey);
        try {
          request = [await transcribeVoice(attachment?.buffer || await downloadMediaMessage(raw, "buffer", {}, { reuploadRequest: socket.updateMediaMessage })), request]
            .filter(Boolean).join("\n\n");
          shouldVoiceReply = true;
        } catch (error) {
          await sendText(groupId, `Не удалось расшифровать голосовое сообщение: ${shortError(error)}`, raw);
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
        const files = await drainOutgoingFiles(group, socket, groupId, raw);
        if (files.errors.length) {
          await sendText(groupId, `Не удалось отправить файл: ${files.errors.join("; ")}`, raw);
        }
      } catch (error) {
        await sendText(groupId, `Говорун не смог выполнить запрос: ${shortError(error)}`, raw);
      }
    } finally {
      stopPresence();
    }
  });
  if (reloadRequested && !restarting) {
    restarting = true;
    await shutdown();
    setTimeout(() => process.exit(75), 500).unref?.();
  }
}

async function connect() {
  if (stopping) return;
  await mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  socket = makeWASocket({
    auth: state,
    logger: pino({ level: "warn" }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });
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
      botJids = new Set([socket.user?.id, socket.user?.lid].filter(Boolean).map(jidNormalizedUser));
      log(`WhatsApp connected; configured groups=${config.groups.size}`);
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
  socket.ev.on("messages.upsert", ({ messages, type }) => {
    // Never replay historical/sync messages into the agent. Only live notify
    // events are allowed to trigger work or YouTube analysis.
    if (type !== "notify") return;
    for (const message of messages) handleMessage(message).catch((error) => log(`message failed: ${shortError(error)}`));
  });
  // New groups are only reported for operator review. They remain inert until
  // their immutable id is entered into the root-owned group configuration.
  socket.ev.on("groups.upsert", (groups) => {
    for (const group of groups || []) log(`observed unconfigured group id=${group.id} subject=${String(group.subject || "").slice(0, 120)}`);
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
process.on("SIGUSR2", () => {
  reloadRequested = true;
  log("self-update requested; will reload after the current message");
});
process.on("SIGHUP", async () => {
  try { config = await loadConfig(); log(`configuration reloaded; configured groups=${config.groups.size}`); }
  catch (error) { log(`configuration reload failed: ${shortError(error)}`); }
});

log(`starting; configured groups=${config.groups.size}; direct chats=${config.directChats.size}; instance=${randomUUID().slice(0, 8)}`);
connect().catch((error) => { console.error(`[govorun] startup failed: ${shortError(error)}`); process.exitCode = 1; });
