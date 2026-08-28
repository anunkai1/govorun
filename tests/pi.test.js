import test from "node:test";
import assert from "node:assert/strict";
import { completedResponse } from "../lib/pi.js";

test("uses a final turn_end without waiting for the aggregate agent_end event", () => {
  const record = {
    type: "turn_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Сайт готов." }],
    },
    toolResults: [],
  };
  assert.equal(completedResponse(record, "Сайт готов."), "Сайт готов.");
});

test("falls back to the final assistant text when streaming deltas are absent", () => {
  const record = {
    type: "turn_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Готово." }],
    },
  };
  assert.equal(completedResponse(record), "Готово.");
});

test("does not complete on a tool-use turn", () => {
  assert.equal(completedResponse({
    type: "turn_end",
    message: { role: "assistant", stopReason: "toolUse", content: [] },
  }, "Работаю"), null);
});

test("retains agent_end as a fallback for small runs", () => {
  assert.equal(completedResponse({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text: "Готово." }] }],
  }), "Готово.");
});
