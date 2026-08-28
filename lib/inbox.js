import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_INCOMING_BYTES = 200 * 1024 * 1024;
const MEDIA_TYPES = new Set(["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"]);

function safeName(value) {
  const name = basename(String(value || "attachment"), "/").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return name || "attachment";
}

function defaultExtension(type, mimetype) {
  if (type === "imageMessage") return ".jpg";
  if (type === "videoMessage") return ".mp4";
  if (type === "audioMessage") return ".ogg";
  if (type === "stickerMessage") return ".webp";
  const value = String(mimetype || "").split("/").pop()?.split(";")[0];
  return value && /^[a-z0-9]{1,8}$/i.test(value) ? `.${value}` : ".bin";
}

export async function saveIncomingAttachment(raw, group, type, content, download) {
  if (!MEDIA_TYPES.has(type)) return null;
  const buffer = await download();
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_INCOMING_BYTES) {
    throw new Error("incoming attachment is missing or larger than 200 MiB");
  }
  const directory = join(group.workspace, "inbox", `${Date.now()}-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const suppliedName = content.fileName || content.filename;
  const filename = safeName(suppliedName || `attachment${defaultExtension(type, content.mimetype)}`);
  const filePath = join(directory, filename.includes(".") ? filename : `${filename}${defaultExtension(type, content.mimetype)}`);
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, buffer, { mode: 0o600, flag: "wx" });
  await rename(temporary, filePath);
  const metadata = {
    messageId: String(raw.key?.id || ""),
    receivedAt: new Date().toISOString(),
    type,
    mimetype: String(content.mimetype || "application/octet-stream"),
    filename,
    bytes: buffer.length,
    path: filePath,
  };
  await writeFile(join(directory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { ...metadata, path: filePath, buffer };
}
