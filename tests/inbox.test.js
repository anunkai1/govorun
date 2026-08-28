import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveIncomingAttachment } from "../lib/inbox.js";

test("saves an incoming attachment with metadata in the chat workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "govorun-inbox-"));
  const result = await saveIncomingAttachment(
    { key: { id: "message-1" } },
    { workspace },
    "imageMessage",
    { mimetype: "image/png", fileName: "picture.png" },
    async () => Buffer.from("image-data"),
  );
  assert.equal(result.filename, "picture.png");
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  const metadata = JSON.parse(await readFile(join(result.path, "..", "metadata.json"), "utf8"));
  assert.equal(metadata.path, result.path);
  assert.equal(metadata.bytes, 10);
});

test("ignores non-media messages", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "govorun-inbox-"));
  assert.equal(await saveIncomingAttachment({}, { workspace }, "conversation", {}, async () => Buffer.from("x")), null);
});
