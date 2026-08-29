import test from "node:test";
import assert from "node:assert/strict";
import { isListenCommand } from "../lib/commands.js";

test("listen command must be the complete text after mentions are removed", () => {
  for (const text of ["listen", "LISTEN", "Listen.", "@Govorun listen", "@61400000000 listen!"]) {
    assert.equal(isListenCommand(text), true, text);
  }
});

test("ordinary sentences containing listen do not arm voice capture", () => {
  for (const text of [
    "please listen to this",
    "listen to this",
    "can you listen",
    "@Govorun please listen to this",
    "listening",
    "listen now",
  ]) {
    assert.equal(isListenCommand(text), false, text);
  }
});
