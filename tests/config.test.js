import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.js";

async function config(value) {
  const directory = await mkdtemp(join(tmpdir(), "govorun-test-"));
  const file = join(directory, "groups.json");
  await writeFile(file, JSON.stringify(value));
  return loadConfig(file);
}

test("loads an empty, closed group allow-list", async () => {
  const value = await config({ groups: [] });
  assert.equal(value.groups.size, 0);
  assert.equal(value.models.primary, "openai-codex/gpt-5.6-luna");
});

test("accepts fixed group IDs and confines workspace slugs", async () => {
  const value = await config({ groups: [{ id: "120363000000000000-123456789@g.us", slug: "family" }] });
  assert.equal(value.groups.get("120363000000000000-123456789@g.us").workspace, "/home/govorun/groups/family");
});

test("rejects paths and malformed group IDs", async () => {
  await assert.rejects(config({ groups: [{ id: "not-a-group", slug: "../lepton" }] }));
});
