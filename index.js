/** Host half of the task overlay: detect actionable Agent moments and hand them to the native Win32 helper. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_PATH = fileURLToPath(new URL("./native/dsh-task-overlay.exe", import.meta.url));
const STATE_PATH = join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? process.cwd(), "DeepSeekHarness", "dsh-task-overlay", "state.bin");
const STATE_VERSION = "DSH-TASK-OVERLAY-1";
const SOUND_ROOT_DIRECTORY_NAME = "sounds";
const OVERLAY_KINDS = Object.freeze([
  "completed",
  "error",
  "blocked",
  "truncated",
  "interrupted",
  "approval",
  "question",
  "schedule",
]);
const MAX_DETAIL_LENGTH = 800;
const POLL_INTERVAL_MS = 150;
const MAX_REMINDER_DELAY_SECONDS = Math.floor(2_147_483_647 / 1000);

/** Loader identity for the task overlay. */
export const name = "task-overlay";

/** Host services required by the overlay. */
export const inject = ["agents"];

/** Create one sound directory for every overlay kind. */
function createSoundDirectories(rootDirectory = dirname(STATE_PATH)) {
  const soundRoot = join(rootDirectory, SOUND_ROOT_DIRECTORY_NAME);
  for (const kind of OVERLAY_KINDS) {
    mkdirSync(join(soundRoot, kind), { recursive: true });
  }
  return soundRoot;
}

/** Compact one-line detail suitable for an overlay body. */
function compactDetail(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim().replace(/\s+/gu, " ");
  if (text === "") return undefined;
  return text.length > MAX_DETAIL_LENGTH
    ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : text;
}

/** Parse one JSON value supplied either as text or as an already decoded object. */
function parseJsonValue(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Extract visible assistant text without exposing reasoning or tool arguments. */
function assistantText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || undefined;
}

/** Read the usable questions from an ask_user_question tool call. */
function questionFromToolArguments(value) {
  const args = parseJsonValue(value);
  if (args === undefined || args === null || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  let questions = args.questions;
  if (typeof questions === "string") questions = parseJsonValue(questions);
  if (!Array.isArray(questions)) return undefined;
  const usable = [];
  for (const question of questions) {
    if (typeof question === "string") {
      const text = question.trim();
      if (text !== "") usable.push({ question: text, header: undefined });
      continue;
    }
    if (question === null || typeof question !== "object") continue;
    const text = typeof question.question === "string" ? question.question.trim() : "";
    if (text === "") continue;
    usable.push({
      question: text,
      header: typeof question.header === "string" ? question.header.trim() : undefined,
    });
  }
  if (usable.length === 0) return undefined;
  return {
    question: usable.map((item) => item.question).join(" / "),
    header: usable.find((item) => item.header !== undefined)?.header,
  };
}

/** Format a duration in milliseconds as a compact human-readable string. */
function formatElapsed(milliseconds) {
  if (milliseconds === undefined || milliseconds === null) return undefined;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * Map one durable turn-end reason to the overlay outcome the user must see.
 * @param {object} reason - The durable `turn/end` reason.
 * @param {string|undefined} summary - The visible assistant text of that turn, when any.
 * @returns {{kind: string, title: string, detail?: string}|undefined} The outcome, or nothing to show.
 */
function turnEndOutcome(reason, summary) {
  if (reason === undefined || reason === null) return undefined;
  switch (reason.kind) {
    case "completed":
      return summary === undefined
        ? undefined
        : { kind: "completed", title: "Tarefa concluída", detail: summary };
    case "error":
      return {
        kind: "error",
        title: "A tarefa falhou",
        detail: reason.error?.message ?? reason.error?.code,
      };
    case "blocked":
      return {
        kind: "blocked",
        title: "A tarefa foi bloqueada",
        detail: "Uma extensão impediu o agente de continuar.",
      };
    case "max-tokens":
      return {
        kind: "truncated",
        title: "Resposta truncada",
        detail: "A resposta atingiu o limite de tokens.",
      };
    case "interrupted":
      return {
        kind: "interrupted",
        title: "A tarefa foi interrompida",
        detail: "A execução foi interrompida antes de concluir.",
      };
    case "aborted":
      // A user, parent, or disposal stop is expected lifecycle; only a hook stop needs attention.
      return reason.reason?.kind === "hook"
        ? { kind: "interrupted", title: "A tarefa foi interrompida", detail: reason.reason.reason }
        : undefined;
    default:
      return undefined;
  }
}

/** Encode one state snapshot as NUL-delimited UTF-8 fields for the native helper. */
function encodeState(payload) {
  const fields = [
    STATE_VERSION,
    payload.eventId,
    payload.kind,
    payload.title,
    payload.detail,
    payload.sessionTitle,
    payload.sessionId,
    String(payload.createdAt),
    payload.elapsed,
  ];
  return Buffer.concat(fields.map((field) => {
    const text = String(field ?? "").replace(/\0/gu, "");
    return Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);
  }));
}

/** Write one state snapshot atomically so the native helper never reads a partial update. */
function writeState(payload, statePath = STATE_PATH) {
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(temporaryPath, encodeState(payload));
  renameSync(temporaryPath, statePath);
}

/** Start the native overlay without tying its lifetime to the headless process. */
function launchHelper(statePath = STATE_PATH, onError = () => {}) {
  const child = spawn(HELPER_PATH, ["--state", statePath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", onError);
  child.unref();
  return child;
}

/** Build the session-event handler with its publisher injected for deterministic tests. */
function createOverlayEventHandler(ctx, publish, now = () => Date.now()) {
  /** Read the current title for one session without making title generation a hard dependency. */
  const titleOf = (session) => {
    const titles = ctx.get("sessionTitle");
    return titles?.get(session)?.title;
  };

  /** Resolve one live session from the session store, when it is available. */
  const sessionById = (id) => ctx.get("sessions")?.get(id);

  /** Classify the session that produced the event and locate its parent session. */
  const sessionScope = (session) => {
    const agent = ctx.agents.get(session.id);
    if (agent === undefined) return undefined;
    if (session.header?.origin !== "subagent") return { kind: "root", session };
    return { kind: "subagent", session, parentSessionId: session.header.parentSession };
  };

  /** The turn currently open in one session, with the moment it started. */
  const openTurns = new Map();

  /** Latest visible assistant text for each open root turn. */
  const assistantSummaries = new Map();
  const summaryKey = (sessionId, turn) => `${sessionId}\u0000${String(turn)}`;

  /** Milliseconds since the open turn of one session started. */
  const elapsedOf = (sessionId) => {
    const open = openTurns.get(sessionId);
    return open === undefined ? undefined : now() - open.startedAt;
  };

  /** Publish one overlay event attributed to the session the user is looking at. */
  const publishOverlay = (scope, outcome, elapsedMs) => {
    const target = scope.kind === "subagent" ? (sessionById(scope.parentSessionId) ?? scope.session) : scope.session;
    const elapsed = formatElapsed(elapsedMs);
    publish({
      kind: outcome.kind,
      title: scope.kind === "subagent" ? `Subagente — ${outcome.title}` : outcome.title,
      sessionId: target.id,
      sessionTitle: titleOf(target),
      detail: compactDetail(outcome.detail),
      ...(elapsed === undefined ? {} : { elapsed }),
    });
  };

  return (session, event) => {
    const sessionId = session?.id;
    if (sessionId === undefined || event === undefined) return;
    const scope = sessionScope(session);
    if (scope === undefined) return;

    if (event.type === "turn/start") {
      openTurns.set(sessionId, { turn: event.data?.turn, startedAt: now() });
      return;
    }

    if (event.type === "assistant/message") {
      if (scope.kind !== "root") return;
      const text = assistantText(event.data?.message);
      if (text !== undefined) {
        assistantSummaries.set(summaryKey(sessionId, event.data?.turn), text);
      }
      return;
    }

    if (event.type === "turn/end") {
      const turn = event.data?.turn;
      const key = summaryKey(sessionId, turn);
      const summary = assistantSummaries.get(key);
      assistantSummaries.delete(key);
      const open = openTurns.get(sessionId);
      const elapsedMs = open !== undefined && open.turn === turn ? now() - open.startedAt : undefined;
      if (open !== undefined && open.turn === turn) openTurns.delete(sessionId);
      const outcome = turnEndOutcome(event.data?.reason, summary);
      if (outcome === undefined) return;
      publishOverlay(scope, outcome, elapsedMs);
      return;
    }

    if (event.type === "approval/asked") {
      const approval = ctx.get("approval");
      const policy = approval?.overrideOf?.(session) ?? approval?.config?.policy ?? "ask";
      if (policy === "never") return;
      publishOverlay(scope, { kind: "approval", title: "Aprovação necessária", detail: event.data?.reason }, elapsedOf(sessionId));
      return;
    }

    if (event.type === "tool/call" && event.data?.name === "ask_user_question") {
      const question = questionFromToolArguments(event.data?.arguments);
      if (question === undefined) return;
      publishOverlay(scope, { kind: "question", title: "Sua intervenção é necessária", detail: question.question }, elapsedOf(sessionId));
    }
  };
}

/** Own reminder timers, independently of the Harness schedule and notification services. */
function createReminderScheduler(publish, now = () => Date.now()) {
  const timers = new Set();
  return {
    create({ message, delay_seconds }, session) {
      if (typeof message !== "string" || message.trim() === "") {
        throw new TypeError("O lembrete precisa de uma mensagem.");
      }
      if (!Number.isSafeInteger(delay_seconds) || delay_seconds < 1 || delay_seconds > MAX_REMINDER_DELAY_SECONDS) {
        throw new RangeError(`O prazo deve ser um inteiro entre 1 e ${MAX_REMINDER_DELAY_SECONDS} segundos.`);
      }
      const id = randomUUID();
      const dueAt = new Date(now() + delay_seconds * 1000).toISOString();
      const detail = compactDetail(message);
      const timer = setTimeout(() => {
        timers.delete(timer);
        publish({
          kind: "schedule",
          title: "Darliing",
          detail,
          sessionId: session.id,
          sessionTitle: session.title,
        });
      }, delay_seconds * 1000);
      timers.add(timer);
      return { id, message: detail, dueAt };
    },
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** Registry-ready tool using the Host's existing JSON Schema tool contract. */
function createReminderTool(ctx, reminders) {
  return {
    name: "overlay_reminder_create",
    description: "Cria um lembrete local com card e som próprios após o prazo informado. Use para pedidos como 'me lembre daqui a 5 horas' (delay_seconds: 18000). Não usa a agenda do Harness e não envia uma mensagem à IA no vencimento. O Harness deve permanecer aberto e o plugin não pode ser recarregado até a entrega.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, description: "Texto que aparecerá no lembrete." },
        delay_seconds: { type: "integer", minimum: 1, maximum: MAX_REMINDER_DELAY_SECONDS, description: "Tempo a partir de agora, em segundos." },
      },
      required: ["message", "delay_seconds"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { id: { type: "string" }, message: { type: "string" }, dueAt: { type: "string" } },
        required: ["id", "message", "dueAt"],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      exec.signal?.throwIfAborted();
      const session = exec.agent?.session;
      if (session === undefined) throw new Error("O lembrete precisa ser criado em uma conversa do Harness.");
      return reminders.create(args, { id: session.id, title: ctx.get("sessionTitle")?.get(session)?.title });
    },
  };
}

/**
 * Register the overlay listener and start its detached native helper.
 * @param {object} ctx - Cordis Host context.
 */
export function apply(ctx) {
  try {
    const soundRoot = createSoundDirectories();
    ctx.logger.info(`task-overlay: custom alert sounds (.wav, .mp3, .m4a, .wma) belong in ${soundRoot}`);
  } catch (error) {
    ctx.logger.warn(`task-overlay: could not create sound directories: ${error instanceof Error ? error.message : String(error)}`);
  }
  const publish = (payload) => {
    const eventId = randomUUID();
    try {
      writeState({ ...payload, eventId, createdAt: Date.now() });
      launchHelper(STATE_PATH, (error) => {
        ctx.logger.warn(`task-overlay: could not start native helper: ${error.message}`);
      });
    } catch (error) {
      ctx.logger.warn(`task-overlay: could not show overlay: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const handler = createOverlayEventHandler(ctx, publish);
  ctx.effect(() => ctx.on("session/event", handler));
  ctx.inject(["tools"], (toolCtx) => {
    const reminders = createReminderScheduler(publish);
    toolCtx.effect(() => () => reminders.dispose());
    toolCtx.tools.register(createReminderTool(toolCtx, reminders));
  });
}

export {
  HELPER_PATH,
  OVERLAY_KINDS,
  POLL_INTERVAL_MS,
  STATE_PATH,
  STATE_VERSION,
  assistantText,
  compactDetail,
  createOverlayEventHandler,
  createReminderScheduler,
  createReminderTool,
  createSoundDirectories,
  encodeState,
  formatElapsed,
  launchHelper,
  parseJsonValue,
  questionFromToolArguments,
  turnEndOutcome,
  writeState,
};
