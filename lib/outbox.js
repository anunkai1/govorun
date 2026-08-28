import { constants } from "node:fs";
import { open, readdir, readFile, realpath, unlink } from "node:fs/promises";
import { basename, join, sep } from "node:path";

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const PUBLISH_DIR = "/var/www/mavali.top/projects/govorun";

function inside(path, root) { return path === root || path.startsWith(`${root}${sep}`); }
function mimetype(name) {
  const extension = name.toLowerCase().split(".").pop();
  return {
    mp3: "audio/mpeg", m4a: "audio/mp4", opus: "audio/ogg", ogg: "audio/ogg",
    wav: "audio/wav", flac: "audio/flac", mp4: "video/mp4", webm: "video/webm",
    pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  }[extension] || "application/octet-stream";
}

export async function drainOutgoingFiles(group, socket, groupId, quoted) {
  const outbox = join(group.workspace, ".govorun-outbox");
  let entries;
  try { entries = await readdir(outbox); } catch (error) {
    if (error.code === "ENOENT") return { sent: [], errors: [] };
    return { sent: [], errors: ["Не удалось прочитать очередь отправки файлов."] };
  }
  const sent = [];
  const errors = [];
  const roots = [await realpath(group.workspace), PUBLISH_DIR];
  for (const entry of entries.filter((name) => /^send-file-[0-9]+\.json$/.test(name)).sort()) {
    const requestPath = join(outbox, entry);
    let request;
    try {
      request = JSON.parse(await readFile(requestPath, "utf8"));
      await unlink(requestPath);
      if (typeof request.path !== "string" || typeof request.caption !== "string") throw new Error("invalid request");
      const path = await realpath(request.path);
      if (!roots.some((root) => inside(path, root))) throw new Error("file is outside the allowed Govorun roots");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("file is missing, not regular, or too large");
        const data = await handle.readFile();
        await socket.sendMessage(groupId, {
          document: data,
          mimetype: mimetype(basename(path)),
          fileName: basename(path),
          ...(request.caption ? { caption: request.caption.slice(0, 1024) } : {}),
        }, { quoted });
        sent.push(basename(path));
      } finally { await handle.close(); }
    } catch (error) {
      errors.push(`${request?.path ? basename(request.path) : entry}: ${String(error?.message || error).slice(0, 240)}`);
    }
  }
  return { sent, errors };
}
