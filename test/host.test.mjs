import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  OVERLAY_KINDS,
  assistantText,
  compactDetail,
  createOverlayEventHandler,
  createSoundDirectories,
  encodeState,
  formatElapsed,
  parseJsonValue,
  questionFromToolArguments,
} from "../index.js";

function createContext({ origin = undefined, approvalPolicy = "ask", parentSession = undefined } = {}) {
  const session = {
    id: "root-session",
    header: { origin, parentSession },
  };
  const sessions = new Map([[session.id, session]]);
  if (parentSession !== undefined) sessions.set(parentSession, { id: parentSession, header: {} });
  return {
    session,
    ctx: {
      agents: {
        get(id) {
          return id === session.id ? { id, session } : undefined;
        },
      },
      get(name) {
        if (name === "sessionTitle") {
          return {
            get: (target) => ({
              title: target.id === parentSession ? "Parent task" : "Build the plugin",
            }),
          };
        }
        if (name === "approval") {
          return {
            config: { policy: approvalPolicy },
            overrideOf: () => undefined,
          };
        }
        if (name === "sessions") return { get: (id) => sessions.get(id) };
        return undefined;
      },
    },
  };
}

test("extracts only visible assistant text", () => {
  assert.equal(assistantText({ content: "  finished  " }), "finished");
  assert.equal(assistantText({ content: [
    { type: "text", text: "visible" },
    { type: "thinking", thinking: "private" },
  ] }), "visible");
  assert.equal(assistantText({ content: [{ type: "thinking", thinking: "private" }] }), undefined);
});

test("reads the first usable question", () => {
  assert.deepEqual(questionFromToolArguments({
    questions: [
      { question: " Which profile? ", header: " Profile " },
      { question: "" },
    ],
  }), {
    question: "Which profile?",
    header: "Profile",
  });
  assert.equal(questionFromToolArguments("not json"), undefined);
});

test("normalizes detail and JSON arguments", () => {
  assert.equal(compactDetail("  line one\n  line two  "), "line one line two");
  assert.deepEqual(parseJsonValue('{"ok":true}'), { ok: true });
  assert.equal(parseJsonValue("not json"), undefined);
});

test("publishes only completed root turns with a visible assistant answer", () => {
  const { ctx, session } = createContext();
  const events = [];
  const handler = createOverlayEventHandler(ctx, (event) => events.push(event));

  handler(session, {
    type: "assistant/message",
    data: { turn: 0, message: { content: [{ type: "text", text: "Done" }] } },
  });
  handler(session, { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    kind: "completed",
    title: "Tarefa concluída",
    sessionId: "root-session",
    sessionTitle: "Build the plugin",
    detail: "Done",
  });
});

test("ignores cancelled turns, missing answers, and subagents", () => {
  const { ctx, session } = createContext();
  const events = [];
  const handler = createOverlayEventHandler(ctx, (event) => events.push(event));

  handler(session, { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } });
  handler(session, {
    type: "assistant/message",
    data: { turn: 1, message: { content: [{ type: "text", text: "Cancelled" }] } },
  });
  handler(session, { type: "turn/end", data: { turn: 1, reason: { kind: "cancelled" } } });

  const child = createContext({ origin: "subagent" });
  child.handler = createOverlayEventHandler(child.ctx, (event) => events.push(event));
  child.handler(child.session, {
    type: "assistant/message",
    data: { turn: 0, message: { content: [{ type: "text", text: "Child" }] } },
  });
  child.handler(child.session, { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } });

  assert.equal(events.length, 0);
});

test("publishes approval and question events but suppresses never policy", () => {
  const approval = createContext();
  const approvalEvents = [];
  const approvalHandler = createOverlayEventHandler(approval.ctx, (event) => approvalEvents.push(event));
  approvalHandler(approval.session, {
    type: "approval/asked",
    data: { reason: "Write outside workspace", toolName: "write" },
  });
  assert.equal(approvalEvents.length, 1);
  assert.equal(approvalEvents[0].kind, "approval");

  const disabled = createContext({ approvalPolicy: "never" });
  const disabledEvents = [];
  const disabledHandler = createOverlayEventHandler(disabled.ctx, (event) => disabledEvents.push(event));
  disabledHandler(disabled.session, { type: "approval/asked", data: { reason: "No prompt" } });
  assert.equal(disabledEvents.length, 0);

  const question = createContext();
  const questionEvents = [];
  const questionHandler = createOverlayEventHandler(question.ctx, (event) => questionEvents.push(event));
  questionHandler(question.session, {
    type: "tool/call",
    data: { name: "ask_user_question", arguments: { questions: ["Continue?"] } },
  });
  assert.equal(questionEvents.length, 1);
  assert.equal(questionEvents[0].kind, "question");
});

test("publishes an error turn even without a visible assistant answer", () => {
  const { ctx, session } = createContext();
  const events = [];
  const handler = createOverlayEventHandler(ctx, (event) => events.push(event));

  handler(session, {
    type: "turn/end",
    data: { turn: 4, reason: { kind: "error", error: { message: "request failed", code: "UPSTREAM" } } },
  });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    kind: "error",
    title: "A tarefa falhou",
    sessionId: "root-session",
    sessionTitle: "Build the plugin",
    detail: "request failed",
  });
});

test("publishes blocked, truncated and interrupted turns", () => {
  const { ctx, session } = createContext();
  const events = [];
  const handler = createOverlayEventHandler(ctx, (event) => events.push(event));

  handler(session, { type: "turn/end", data: { turn: 1, reason: { kind: "blocked" } } });
  handler(session, { type: "turn/end", data: { turn: 2, reason: { kind: "max-tokens" } } });
  handler(session, { type: "turn/end", data: { turn: 3, reason: { kind: "interrupted" } } });
  handler(session, {
    type: "turn/end",
    data: { turn: 4, reason: { kind: "aborted", reason: { kind: "hook", reason: "budget exhausted" } } },
  });

  assert.deepEqual(events.map((event) => event.kind), ["blocked", "truncated", "interrupted", "interrupted"]);
  assert.equal(events[0].title, "A tarefa foi bloqueada");
  assert.equal(events[1].title, "Resposta truncada");
  assert.equal(events[2].title, "A tarefa foi interrompida");
  assert.equal(events[3].detail, "budget exhausted");
});

test("ignores expected stops and turns without a visible answer", () => {
  const { ctx, session } = createContext();
  const events = [];
  const handler = createOverlayEventHandler(ctx, (event) => events.push(event));

  handler(session, { type: "turn/end", data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } } });
  handler(session, { type: "turn/end", data: { turn: 2, reason: { kind: "aborted", reason: { kind: "parent" } } } });
  handler(session, { type: "turn/end", data: { turn: 3, reason: { kind: "aborted", reason: { kind: "disposed" } } } });
  handler(session, { type: "turn/end", data: { turn: 4, reason: { kind: "forked" } } });
  handler(session, { type: "turn/end", data: { turn: 5, reason: { kind: "completed" } } });

  assert.equal(events.length, 0);
});

test("formats the elapsed time for the overlay", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(45_000), "45s");
  assert.equal(formatElapsed(154_000), "2m 34s");
  assert.equal(formatElapsed(3_720_000), "1h 02m");
  assert.equal(formatElapsed(undefined), undefined);
});

test("reports how long the turn took when the overlay is published", () => {
  const { ctx, session } = createContext();
  const events = [];
  let clock = 1_000;
  const handler = createOverlayEventHandler(ctx, (event) => events.push(event), () => clock);

  handler(session, { type: "turn/start", data: { turn: 0 } });
  clock = 155_000;
  handler(session, { type: "assistant/message", data: { turn: 0, message: { content: [{ type: "text", text: "Done" }] } } });
  handler(session, { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } });

  assert.equal(events.length, 1);
  assert.equal(events[0].elapsed, "2m 34s");
});

test("attributes a failed subagent to its parent session", () => {
  const { ctx, session } = createContext({ origin: "subagent", parentSession: "parent-session" });
  const events = [];
  const handler = createOverlayEventHandler(ctx, (event) => events.push(event));

  handler(session, { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "subagent boom" } } } });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    kind: "error",
    title: "Subagente — A tarefa falhou",
    sessionId: "parent-session",
    sessionTitle: "Parent task",
    detail: "subagent boom",
  });
});

test("creates one sound directory for every overlay kind", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-task-overlay-"));
  try {
    const soundRoot = createSoundDirectories(root);
    assert.deepEqual(OVERLAY_KINDS, [
      "completed",
      "error",
      "blocked",
      "truncated",
      "interrupted",
      "approval",
      "question",
    ]);
    assert.equal(soundRoot, join(root, "sounds"));
    for (const kind of OVERLAY_KINDS) {
      assert.equal(existsSync(join(soundRoot, kind)), true);
    }
    assert.doesNotThrow(() => createSoundDirectories(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("encodes state as stable NUL-delimited UTF-8 fields", () => {
  const encoded = encodeState({
    eventId: "event-1",
    kind: "completed",
    title: "Tarefa concluída",
    detail: "Pronto",
    sessionTitle: "Sessão",
    sessionId: "session-1",
    createdAt: 123,
  });
  const fields = encoded.toString("utf8").split("\0");

  assert.equal(fields[0], "DSH-TASK-OVERLAY-1");
  assert.equal(fields[1], "event-1");
  assert.equal(fields[3], "Tarefa concluída");
  assert.equal(fields[7], "123");
});
