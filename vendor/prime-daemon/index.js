// Generated from PrimeIntellect-ai/prime-agent 878410b3981f20c6d685faa210ad0e43426cf483. See provenance.json and LICENSE.

// packages/coding-agent/src/modes/daemon/daemon-client.ts
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

// packages/coding-agent/src/config.ts
import { createHash } from "crypto";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync
} from "fs";
import { homedir } from "os";
import { basename, dirname, join, posix, resolve as resolve2, sep, win32 } from "path";
import { fileURLToPath } from "url";

// packages/coding-agent/src/utils/daemon-socket-path.ts
import { resolve } from "node:path";
function normalizeSocketPath(socketPath, baseDir) {
  if (process.platform === "win32") {
    return socketPath.toLowerCase();
  }
  return baseDir ? resolve(baseDir, socketPath) : resolve(socketPath);
}

// packages/coding-agent/src/config.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);
var isBunBinary = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");
var isBunRuntime = !!process.versions.bun;
function getPackageDir() {
  const envDir = process.env.PI_PACKAGE_DIR;
  if (envDir) {
    return expandTildePath(envDir);
  }
  if (isBunBinary) {
    return dirname(process.execPath);
  }
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return __dirname;
}
function getPackageJsonPath() {
  return join(getPackageDir(), "package.json");
}
var pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8"));
var piConfigName = pkg.piConfig?.name;
var envPrefix = (piConfigName || "pi").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "PI";
var PACKAGE_NAME = pkg.name || "@earendil-works/pi-coding-agent";
var CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".prime/agent";
var VERSION = pkg.version || "0.0.0";
var ENV_AGENT_DIR = `${envPrefix}_CODING_AGENT_DIR`;
var ENV_SESSION_DIR = `${envPrefix}_SESSION_DIR`;
var ENV_LEGACY_SESSION_DIR = `${envPrefix}_CODING_AGENT_SESSION_DIR`;
function expandTildePath(path, platform = process.platform) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || platform === "win32" && path.startsWith("~\\")) {
    return (platform === "win32" ? win32 : posix).join(homedir(), path.slice(2));
  }
  return path;
}
function getAgentDir() {
  const envDir = process.env[ENV_AGENT_DIR];
  if (envDir) {
    return expandTildePath(envDir);
  }
  return join(homedir(), CONFIG_DIR_NAME);
}
function getLogsDir() {
  return join(getAgentDir(), "logs");
}
function getAgentLogPath() {
  return join(getLogsDir(), "agent.jsonl");
}
function getDaemonLogPath(socketPath) {
  const normalized = normalizeSocketPath(socketPath);
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return join(getLogsDir(), `${basename(normalized)}.${hash}.log`);
}
var MAX_LOG_BYTES = 5 * 1024 * 1024;
function appendRotatingLog(logPath, message, maxBytes = MAX_LOG_BYTES) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    try {
      if (existsSync(logPath) && statSync(logPath).size > maxBytes) {
        rmSync(`${logPath}.old`, { force: true });
        renameSync(logPath, `${logPath}.old`);
      }
    } catch {
    }
    appendFileSync(logPath, `${message}
`);
  } catch {
  }
}

// packages/coding-agent/src/modes/rpc/jsonl.ts
import { StringDecoder } from "node:string_decoder";
function serializeJsonLine(value) {
  return `${JSON.stringify(value)}
`;
}
function attachJsonlLineReader(stream, onLine, options = {}) {
  const decoder = new StringDecoder("utf8");
  let pending = [];
  let pendingLength = 0;
  let discardingOverflow = false;
  const emitLine = (line) => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  const resetPending = () => {
    pending = [];
    pendingLength = 0;
  };
  const appendPending = (segment) => {
    if (discardingOverflow || segment.length === 0) return;
    const maxLineLength = options.maxLineLength;
    if (maxLineLength !== void 0 && pendingLength + segment.length > maxLineLength) {
      const remaining = Math.max(0, maxLineLength - pendingLength);
      if (remaining > 0) {
        pending.push(segment.slice(0, remaining));
      }
      options.onLineOverflow?.(pending.join(""));
      resetPending();
      discardingOverflow = true;
      return;
    }
    pending.push(segment);
    pendingLength += segment.length;
  };
  const emitFrom = (segment) => {
    if (discardingOverflow) {
      discardingOverflow = false;
      resetPending();
      return;
    }
    appendPending(segment);
    if (discardingOverflow) {
      discardingOverflow = false;
      return;
    }
    emitLine(pending.join(""));
    resetPending();
  };
  const onData = (chunk) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    let newlineIndex = text.indexOf("\n");
    while (newlineIndex !== -1) {
      emitFrom(text.slice(start, newlineIndex));
      start = newlineIndex + 1;
      newlineIndex = text.indexOf("\n", start);
    }
    if (start < text.length) {
      appendPending(text.slice(start));
    }
  };
  const onEnd = () => {
    const tail = decoder.end();
    if (tail.length > 0) {
      appendPending(tail);
    }
    if (!discardingOverflow && pending.length > 0) {
      emitLine(pending.join(""));
    }
    resetPending();
    discardingOverflow = false;
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

// packages/coding-agent/src/modes/daemon/daemon-protocol.ts
var DAEMON_PROTOCOL_NAME = "prime-agent.daemon";
var DAEMON_PROTOCOL_VERSION = 7;
var DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION = 7;
var DAEMON_SUPPORTED_CLIENT_CAPABILITIES = [
  "attach_snapshot",
  "event_sequence",
  "extension_ui",
  "slim_attach",
  "chunked_snapshot",
  "client_owned_sessions"
];
var DAEMON_DEFAULT_SERVER_CAPABILITIES = [
  ...DAEMON_SUPPORTED_CLIENT_CAPABILITIES,
  "delete_rlm_subagent",
  "heartbeat_catalog",
  "heartbeat_management",
  "model_catalog",
  "side_question_transcript",
  "transient_bash",
  "session_input_admission",
  "prompt_admission_cancellation",
  "owned_prompt_cancellation",
  "queue_message_mutation",
  "authoritative_child_roster",
  "owned_session_recovery_context",
  "rlm_quiescence_barrier",
  "session_input_pause",
  "acp_mcp_servers"
];
var DAEMON_CLIENT_ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID"
];
function collectDaemonClientEnv(source = process.env) {
  const env = {};
  for (const key of DAEMON_CLIENT_ENV_KEYS) {
    const value = source[key];
    if (value !== void 0) {
      env[key] = value;
    }
  }
  return Object.keys(env).length > 0 ? env : void 0;
}
function collectDaemonLaunchEnv(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== void 0 && !key.startsWith("PRIME_AGENT_INTERNAL_")) {
      env[key] = value;
    }
  }
  return env;
}
var LEGACY_DAEMON_COMMAND = { minProtocol: 7 };
var CURRENT_DAEMON_COMMAND = { minProtocol: 7 };
var RLM_MAX_DEPTH_COMMAND = { minProtocol: 7, minSchemaRevision: 11 };
var SESSION_INPUT_ADMISSION_COMMAND = {
  minProtocol: 7,
  capability: "session_input_admission"
};
var PROMPT_ADMISSION_CANCELLATION_COMMAND = {
  minProtocol: 7,
  minSchemaRevision: 8,
  capability: "prompt_admission_cancellation"
};
var OWNED_PROMPT_CANCELLATION_COMMAND = {
  minProtocol: 7,
  minSchemaRevision: 20,
  capability: "owned_prompt_cancellation"
};
var CLIENT_OWNED_DAEMON_COMMAND = {
  minProtocol: 7,
  capability: "client_owned_sessions"
};
var DELETE_RLM_SUBAGENT_COMMAND = {
  minProtocol: 7,
  capability: "delete_rlm_subagent"
};
var FLAT_SESSION_TREE_COMMAND = { minProtocol: 7 };
var TELEMETRY_POLICY_COMMAND = { minProtocol: 7, minSchemaRevision: 14 };
var AUTHORITATIVE_CHILD_ROSTER_COMMAND = {
  minProtocol: 7,
  minSchemaRevision: 17,
  capability: "authoritative_child_roster"
};
var OWNED_SESSION_RECOVERY_CONTEXT = {
  minProtocol: 7,
  minSchemaRevision: 17,
  capability: "owned_session_recovery_context"
};
var RLM_QUIESCENCE_BARRIER_COMMAND = {
  minProtocol: 7,
  minSchemaRevision: 18,
  capability: "rlm_quiescence_barrier"
};
var SESSION_INPUT_PAUSE_COMMAND = {
  minProtocol: 7,
  minSchemaRevision: 19,
  capability: "session_input_pause"
};
var AGENT_PEER_LIST_COMMAND = { minProtocol: 7, minSchemaRevision: 23 };
var DIRECT_PEER_TRANSPORT_COMMAND = {
  minProtocol: 7,
  minSchemaRevision: 25,
  capability: "direct_peer_transport"
};
var DAEMON_COMMAND_COMPATIBILITY = {
  ack_result: LEGACY_DAEMON_COMMAND,
  list: LEGACY_DAEMON_COMMAND,
  list_saved_sessions: LEGACY_DAEMON_COMMAND,
  list_agent_peers: AGENT_PEER_LIST_COMMAND,
  get_direct_worker_transport: DIRECT_PEER_TRANSPORT_COMMAND,
  create: LEGACY_DAEMON_COMMAND,
  attach: LEGACY_DAEMON_COMMAND,
  reattach: LEGACY_DAEMON_COMMAND,
  detach: LEGACY_DAEMON_COMMAND,
  complete_owned_session: CLIENT_OWNED_DAEMON_COMMAND,
  promote_owned_session: CLIENT_OWNED_DAEMON_COMMAND,
  kill: LEGACY_DAEMON_COMMAND,
  rename: LEGACY_DAEMON_COMMAND,
  prompt: SESSION_INPUT_ADMISSION_COMMAND,
  cancel_prompt_admission: PROMPT_ADMISSION_CANCELLATION_COMMAND,
  prompt_and_wait: SESSION_INPUT_ADMISSION_COMMAND,
  steer: SESSION_INPUT_ADMISSION_COMMAND,
  follow_up: SESSION_INPUT_ADMISSION_COMMAND,
  restore_next_turn: LEGACY_DAEMON_COMMAND,
  restore_actions: LEGACY_DAEMON_COMMAND,
  append_custom_message: LEGACY_DAEMON_COMMAND,
  resume_queue: SESSION_INPUT_ADMISSION_COMMAND,
  send_message: LEGACY_DAEMON_COMMAND,
  agent_messages_status: LEGACY_DAEMON_COMMAND,
  agent_messages_pause: LEGACY_DAEMON_COMMAND,
  agent_messages_resume: LEGACY_DAEMON_COMMAND,
  agent_messages_clear: LEGACY_DAEMON_COMMAND,
  abort: LEGACY_DAEMON_COMMAND,
  start_side_question: LEGACY_DAEMON_COMMAND,
  abort_side_question: LEGACY_DAEMON_COMMAND,
  execute_bash: LEGACY_DAEMON_COMMAND,
  abort_bash: LEGACY_DAEMON_COMMAND,
  cancel_rlm_child: LEGACY_DAEMON_COMMAND,
  delete_rlm_subagent: DELETE_RLM_SUBAGENT_COMMAND,
  wait_for_idle: LEGACY_DAEMON_COMMAND,
  wait_for_headless_completion: CURRENT_DAEMON_COMMAND,
  get_session_header: CURRENT_DAEMON_COMMAND,
  get_state: LEGACY_DAEMON_COMMAND,
  get_connection_state: LEGACY_DAEMON_COMMAND,
  get_messages: LEGACY_DAEMON_COMMAND,
  get_rlm_children: AUTHORITATIVE_CHILD_ROSTER_COMMAND,
  get_session_stats: LEGACY_DAEMON_COMMAND,
  get_context_tree: LEGACY_DAEMON_COMMAND,
  get_commands: LEGACY_DAEMON_COMMAND,
  get_resource_snapshot: LEGACY_DAEMON_COMMAND,
  replace_acp_mcp_servers: { minProtocol: 7, minSchemaRevision: 22, capability: "acp_mcp_servers" },
  get_model_catalog: { minProtocol: 7, capability: "model_catalog" },
  get_available_models: LEGACY_DAEMON_COMMAND,
  get_queue: LEGACY_DAEMON_COMMAND,
  mutate_queued_message: { minProtocol: 7, minSchemaRevision: 15, capability: "queue_message_mutation" },
  clear_queue: LEGACY_DAEMON_COMMAND,
  abort_and_clear_queue: LEGACY_DAEMON_COMMAND,
  acquire_session_input_pause: SESSION_INPUT_PAUSE_COMMAND,
  release_session_input_pause: SESSION_INPUT_PAUSE_COMMAND,
  cron_list: LEGACY_DAEMON_COMMAND,
  heartbeats_list: { minProtocol: 7, capability: "heartbeat_catalog" },
  roster_subscribe: { minProtocol: 7, capability: "agent_roster" },
  roster_unsubscribe: { minProtocol: 7, capability: "agent_roster" },
  heartbeat_manage: { minProtocol: 7, capability: "heartbeat_management" },
  cron_add: LEGACY_DAEMON_COMMAND,
  cron_cancel: LEGACY_DAEMON_COMMAND,
  heartbeat_get: LEGACY_DAEMON_COMMAND,
  heartbeat_set: LEGACY_DAEMON_COMMAND,
  heartbeat_update: LEGACY_DAEMON_COMMAND,
  set_model: LEGACY_DAEMON_COMMAND,
  cycle_model: LEGACY_DAEMON_COMMAND,
  set_scoped_models: LEGACY_DAEMON_COMMAND,
  set_thinking_level: LEGACY_DAEMON_COMMAND,
  set_service_tier: LEGACY_DAEMON_COMMAND,
  cycle_thinking_level: LEGACY_DAEMON_COMMAND,
  set_transport: LEGACY_DAEMON_COMMAND,
  set_steering_mode: LEGACY_DAEMON_COMMAND,
  set_follow_up_mode: LEGACY_DAEMON_COMMAND,
  set_auto_compaction: LEGACY_DAEMON_COMMAND,
  set_auto_retry: CURRENT_DAEMON_COMMAND,
  compact: LEGACY_DAEMON_COMMAND,
  refine: LEGACY_DAEMON_COMMAND,
  abort_compaction: LEGACY_DAEMON_COMMAND,
  abort_branch_summary: LEGACY_DAEMON_COMMAND,
  abort_retry: LEGACY_DAEMON_COMMAND,
  execute_bash_and_wait: CURRENT_DAEMON_COMMAND,
  reload: LEGACY_DAEMON_COMMAND,
  new_session: LEGACY_DAEMON_COMMAND,
  switch_session: LEGACY_DAEMON_COMMAND,
  fork: LEGACY_DAEMON_COMMAND,
  navigate_tree: LEGACY_DAEMON_COMMAND,
  import_jsonl: LEGACY_DAEMON_COMMAND,
  export_html: LEGACY_DAEMON_COMMAND,
  export_jsonl: LEGACY_DAEMON_COMMAND,
  set_session_name: LEGACY_DAEMON_COMMAND,
  get_rlm_max_depth_status: RLM_MAX_DEPTH_COMMAND,
  set_rlm_max_depth: RLM_MAX_DEPTH_COMMAND,
  rename_saved_session: LEGACY_DAEMON_COMMAND,
  delete_saved_session: LEGACY_DAEMON_COMMAND,
  get_session_context: LEGACY_DAEMON_COMMAND,
  get_session_tree: FLAT_SESSION_TREE_COMMAND,
  get_user_messages_for_forking: LEGACY_DAEMON_COMMAND,
  get_last_assistant_text: LEGACY_DAEMON_COMMAND,
  get_system_prompt: LEGACY_DAEMON_COMMAND,
  get_tool_definition: LEGACY_DAEMON_COMMAND,
  set_session_entry_label: LEGACY_DAEMON_COMMAND,
  extension_ui_response: LEGACY_DAEMON_COMMAND,
  prepare_update_restart: LEGACY_DAEMON_COMMAND,
  retry_worker: LEGACY_DAEMON_COMMAND,
  restart: LEGACY_DAEMON_COMMAND,
  shutdown: LEGACY_DAEMON_COMMAND
};
var DAEMON_COMMAND_PLANE = {
  ack_result: "control",
  list: "control",
  list_saved_sessions: "control",
  list_agent_peers: "control",
  get_direct_worker_transport: "control",
  create: "control",
  attach: "session",
  reattach: "control",
  detach: "session",
  complete_owned_session: "control",
  promote_owned_session: "control",
  kill: "control",
  rename: "control",
  prompt: "session",
  cancel_prompt_admission: "session",
  prompt_and_wait: "session",
  steer: "session",
  follow_up: "session",
  restore_next_turn: "session",
  restore_actions: "session",
  append_custom_message: "session",
  resume_queue: "session",
  send_message: "control",
  agent_messages_status: "control",
  agent_messages_pause: "control",
  agent_messages_resume: "control",
  agent_messages_clear: "control",
  abort: "session",
  start_side_question: "session",
  abort_side_question: "session",
  execute_bash: "session",
  abort_bash: "session",
  cancel_rlm_child: "session",
  delete_rlm_subagent: "session",
  wait_for_idle: "session",
  wait_for_headless_completion: "session",
  get_session_header: "session",
  get_state: "session",
  get_connection_state: "session",
  get_messages: "session",
  get_rlm_children: "session",
  get_session_stats: "session",
  get_context_tree: "session",
  get_commands: "session",
  get_resource_snapshot: "session",
  replace_acp_mcp_servers: "session",
  get_model_catalog: "session",
  get_available_models: "session",
  get_queue: "session",
  mutate_queued_message: "session",
  clear_queue: "session",
  abort_and_clear_queue: "session",
  acquire_session_input_pause: "session",
  release_session_input_pause: "session",
  cron_list: "control",
  heartbeats_list: "control",
  roster_subscribe: "control",
  roster_unsubscribe: "control",
  heartbeat_manage: "control",
  cron_add: "control",
  cron_cancel: "control",
  heartbeat_get: "control",
  heartbeat_set: "control",
  heartbeat_update: "control",
  set_model: "session",
  cycle_model: "session",
  set_scoped_models: "session",
  set_thinking_level: "session",
  set_service_tier: "session",
  cycle_thinking_level: "session",
  set_transport: "session",
  set_steering_mode: "session",
  set_follow_up_mode: "session",
  set_auto_compaction: "session",
  set_auto_retry: "session",
  compact: "session",
  refine: "session",
  abort_compaction: "session",
  abort_branch_summary: "session",
  abort_retry: "session",
  execute_bash_and_wait: "session",
  reload: "session",
  new_session: "session",
  switch_session: "session",
  fork: "session",
  navigate_tree: "session",
  import_jsonl: "session",
  export_html: "session",
  export_jsonl: "session",
  set_session_name: "control",
  get_rlm_max_depth_status: "session",
  set_rlm_max_depth: "session",
  rename_saved_session: "control",
  delete_saved_session: "control",
  get_session_context: "session",
  get_session_tree: "session",
  get_user_messages_for_forking: "session",
  get_last_assistant_text: "session",
  get_system_prompt: "session",
  get_tool_definition: "session",
  set_session_entry_label: "session",
  extension_ui_response: "session",
  prepare_update_restart: "control",
  retry_worker: "control",
  restart: "control",
  shutdown: "control"
};
function isSessionPlaneDaemonCommand(type) {
  return DAEMON_COMMAND_PLANE[type] === "session";
}
function getDaemonCommandCompatibilities(command) {
  const requirements = [];
  if ((command.type === "attach" || command.type === "reattach") && command.recoveryConfig !== void 0) {
    requirements.push(OWNED_SESSION_RECOVERY_CONTEXT);
  }
  const carriesTelemetryPolicy = (command.type === "attach" || command.type === "reattach") && command.telemetryDisabled !== void 0 || command.type === "create" && command.config?.telemetryDisabled !== void 0;
  if (carriesTelemetryPolicy) requirements.push(TELEMETRY_POLICY_COMMAND);
  if ((command.type === "prompt" || command.type === "prompt_and_wait") && command.admissionId !== void 0) {
    requirements.push(PROMPT_ADMISSION_CANCELLATION_COMMAND);
  }
  if (command.type === "wait_for_headless_completion" && command.waitForRlmQuiescence === true) {
    requirements.push(RLM_QUIESCENCE_BARRIER_COMMAND);
  }
  if (command.type === "cancel_prompt_admission" && command.cancelOwned === true) {
    requirements.push(OWNED_PROMPT_CANCELLATION_COMMAND);
  }
  return [...requirements, DAEMON_COMMAND_COMPATIBILITY[command.type]];
}
function meetsDaemonCommandCompatibility(hello, compatibility) {
  return hello.protocol.version >= compatibility.minProtocol && (compatibility.minSchemaRevision === void 0 || (hello.schemaRevision ?? 0) >= compatibility.minSchemaRevision) && (compatibility.capability === void 0 || hello.serverCapabilities?.includes(compatibility.capability) === true);
}
function isUnknownDaemonCommandError(error, command) {
  return error instanceof Error && error.message.includes(`Unknown daemon command: ${command}`);
}
function createDaemonCommandEnvelope(command, id, clientId, protocolVersion = DAEMON_PROTOCOL_VERSION) {
  return {
    type: "command",
    id,
    protocol: { name: DAEMON_PROTOCOL_NAME, version: protocolVersion },
    ...clientId ? { clientId } : {},
    command
  };
}
var READ_ONLY_DAEMON_COMMANDS = /* @__PURE__ */ new Set([
  "ack_result",
  "list",
  "list_saved_sessions",
  "list_agent_peers",
  "get_direct_worker_transport",
  "attach",
  "reattach",
  "roster_subscribe",
  "roster_unsubscribe",
  "agent_messages_status",
  "wait_for_idle",
  "get_session_header",
  "get_state",
  "get_connection_state",
  "get_messages",
  "get_rlm_children",
  "get_session_stats",
  "get_context_tree",
  "get_commands",
  "get_resource_snapshot",
  "get_model_catalog",
  "get_available_models",
  "get_queue",
  "cron_list",
  "heartbeats_list",
  "heartbeat_get",
  "get_session_context",
  "get_session_tree",
  "get_user_messages_for_forking",
  "get_last_assistant_text",
  "get_system_prompt",
  "get_rlm_max_depth_status",
  "get_tool_definition"
]);
function isDaemonMutatingCommand(command) {
  return !READ_ONLY_DAEMON_COMMANDS.has(command.type);
}

// packages/coding-agent/src/modes/daemon/daemon-client.ts
function daemonEndpointDetails(socketPath) {
  return `Socket: ${socketPath}. Daemon log: ${getDaemonLogPath(socketPath)}.`;
}
var DaemonSocketClosedError = class extends Error {
  constructor(socketPath, daemonClosingReason, cause) {
    const reasonDetails = daemonClosingReason ? ` Reason: ${daemonClosingReason}.` : "";
    const causeDetails = cause ? ` Cause: ${cause}.` : "";
    super(
      `Connection to the Prime Agent daemon closed.${reasonDetails}${causeDetails} ${daemonEndpointDetails(socketPath)}`
    );
    this.daemonClosingReason = daemonClosingReason;
    this.name = "DaemonSocketClosedError";
  }
};
var DaemonCapabilityUnavailableError = class extends Error {
  constructor(command, capability, afterReconnect = false) {
    super(
      capability ? `The running Prime Agent daemon does not support ${capability}.` : `The running Prime Agent daemon does not support ${command}.`
    );
    this.command = command;
    this.capability = capability;
    this.afterReconnect = afterReconnect;
    this.name = "DaemonCapabilityUnavailableError";
  }
};
function getDaemonSocketCloseReason(error) {
  return error instanceof DaemonSocketClosedError ? error.daemonClosingReason : void 0;
}
var DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 3e4;
var WINDOWS_DAEMON_CREATE_TIMEOUT_MS = 12e4;
function defaultDaemonRequestTimeout(command) {
  return command.type === "create" && process.platform === "win32" ? WINDOWS_DAEMON_CREATE_TIMEOUT_MS : DEFAULT_DAEMON_REQUEST_TIMEOUT_MS;
}
var DEFAULT_RECONNECT_TIMEOUT_MS = 6e4;
var RECONNECT_CONNECT_TIMEOUT_MS = 1e3;
var RECONNECT_HELLO_TIMEOUT_MS = 3e3;
var MAX_RECONNECT_DELAY_MS = 2e3;
var DaemonClient = class {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.listeners = /* @__PURE__ */ new Set();
    this.closeListeners = /* @__PURE__ */ new Set();
    this.pendingRequests = /* @__PURE__ */ new Map();
    this.requestId = 0;
    this.protocolClientId = `daemon-client:${randomUUID()}`;
    this.requestRecoveryEnabled = false;
    this.closed = false;
    this.helloWaiters = /* @__PURE__ */ new Set();
  }
  get hello() {
    return this.helloMessage;
  }
  get isConnected() {
    return this.socket !== void 0 && !this.socket.destroyed;
  }
  supportsServerCapability(capability) {
    return this.helloMessage?.serverCapabilities?.includes(capability) === true;
  }
  /** Wait for the daemon_hello greeting sent on connect. */
  async waitForHello(timeoutMs = 3e3) {
    if (this.helloMessage) {
      return this.helloMessage;
    }
    if (!this.socket || this.socket.destroyed) {
      throw new Error(
        `Cannot wait for the Prime Agent daemon handshake because the daemon is not connected. ${daemonEndpointDetails(this.socketPath)}`
      );
    }
    return new Promise((resolve3, reject) => {
      const waiter = {
        resolve: resolve3,
        reject,
        timeout: setTimeout(() => {
          this.helloWaiters.delete(waiter);
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for the Prime Agent daemon handshake. ${daemonEndpointDetails(this.socketPath)}`
            )
          );
        }, timeoutMs)
      };
      this.helloWaiters.add(waiter);
    });
  }
  async connect(timeoutMs = 3e3) {
    if (this.socket) {
      throw new Error(`Prime Agent daemon client is already connected. ${daemonEndpointDetails(this.socketPath)}`);
    }
    this.helloMessage = void 0;
    this.daemonClosingReason = void 0;
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    this.detachReader = attachJsonlLineReader(socket, (line) => this.handleLine(line));
    await new Promise((resolve3, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        this.clearSocketReference(socket);
        socket.destroy();
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms connecting to the Prime Agent daemon. ${daemonEndpointDetails(this.socketPath)}`
          )
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      const onConnect = () => {
        cleanup();
        resolve3();
      };
      const onError = (error) => {
        cleanup();
        this.clearSocketReference(socket);
        reject(
          new Error(
            `Failed to connect to the Prime Agent daemon: ${error.message}. ${daemonEndpointDetails(this.socketPath)}`
          )
        );
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    socket.on(
      "error",
      (error) => this.notifyClosed(
        socket,
        this.daemonClosingReason ? new DaemonSocketClosedError(this.socketPath, this.daemonClosingReason, error.message) : error
      )
    );
    socket.on(
      "close",
      () => this.notifyClosed(socket, new DaemonSocketClosedError(this.socketPath, this.daemonClosingReason))
    );
  }
  async reconnect(timeoutMs = 3e3) {
    if (this.reconnectPromise) {
      return this.reconnectPromise;
    }
    if (this.socket && !this.socket.destroyed) {
      return;
    }
    const reconnectPromise = this.connect(timeoutMs);
    this.reconnectPromise = reconnectPromise;
    try {
      await reconnectPromise;
    } finally {
      if (this.reconnectPromise === reconnectPromise) {
        this.reconnectPromise = void 0;
      }
    }
  }
  disconnectForReconnect(reason) {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return;
    }
    this.daemonClosingReason = reason;
    this.notifyClosed(socket, new DaemonSocketClosedError(this.socketPath, reason));
    socket.end();
    socket.destroy();
  }
  /** Discard a partially recovered transport so the next retry can reconnect cleanly. */
  resetTransportForReconnect() {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.clearSocketReference(socket);
    this.rejectAll(
      new DaemonSocketClosedError(this.socketPath, void 0, "reconnect attempt did not complete"),
      this.requestRecoveryEnabled
    );
    socket.destroy();
  }
  onMessage(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onClose(listener) {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }
  /** Keep in-flight command promises alive and resend their stable envelopes after reconnect. */
  enableRequestRecovery() {
    this.requestRecoveryEnabled = true;
  }
  /** Reconnect a global/raw daemon client after supervisor replacement. */
  enableAutoReconnect(options) {
    this.requestRecoveryEnabled = true;
    this.reconnectOptions = options;
  }
  async request(command, timeoutMs = defaultDaemonRequestTimeout(command), options = {}) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error(
        `Cannot send daemon command "${command.type}" because the Prime Agent daemon is not connected. ${daemonEndpointDetails(this.socketPath)}`
      );
    }
    const hello = this.helloMessage ?? await this.waitForHello();
    const compatibilities = getDaemonCommandCompatibilities(command);
    const missingCompatibility = compatibilities.find(
      (compatibility) => !meetsDaemonCommandCompatibility(hello, compatibility)
    );
    if (missingCompatibility) {
      throw new DaemonCapabilityUnavailableError(command.type, missingCompatibility.capability);
    }
    const envelopeProtocolVersion = Math.min(hello.protocol.version, DAEMON_PROTOCOL_VERSION);
    return this.requestWire(
      command,
      timeoutMs,
      options,
      envelopeProtocolVersion >= DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION ? envelopeProtocolVersion : void 0,
      compatibilities
    );
  }
  async authenticateWorker(token, timeoutMs = 3e3) {
    const legacyAuthentication = { type: "worker_auth", token };
    const response = await this.requestWire(legacyAuthentication, timeoutMs);
    if (!response.success) {
      throw new Error(response.error);
    }
  }
  async requestWorker(command, timeoutMs = 3e4) {
    return this.requestWire(command, timeoutMs);
  }
  async requestWire(command, timeoutMs, options = {}, publicEnvelopeProtocolVersion, compatibilities = []) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error(
        `Cannot send daemon command "${command.type}" because the Prime Agent daemon is not connected. ${daemonEndpointDetails(this.socketPath)}`
      );
    }
    const id = `daemon_${++this.requestId}`;
    const fullCommand = { ...command, id };
    const wireCommand = publicEnvelopeProtocolVersion ? createDaemonCommandEnvelope(
      fullCommand,
      id,
      this.protocolClientId,
      publicEnvelopeProtocolVersion
    ) : fullCommand;
    const wireData = serializeJsonLine(wireCommand);
    const acknowledgeResult = publicEnvelopeProtocolVersion !== void 0 && isDaemonMutatingCommand(fullCommand);
    return new Promise((resolve3, reject) => {
      const pending = {
        resolve: resolve3,
        reject,
        timeoutMs,
        commandType: command.type,
        onProgress: options.onProgress,
        wireData,
        awaitingReconnect: false,
        acknowledgeResult,
        recoverable: options.recoverable !== false,
        compatibilities
      };
      this.pendingRequests.set(id, pending);
      this.armPendingRequestTimeout(id, pending);
      this.socket.write(wireData);
    });
  }
  armPendingRequestTimeout(id, pending) {
    pending.timeout = setTimeout(() => {
      this.pendingRequests.delete(id);
      pending.reject(
        new Error(
          `Timed out after ${pending.timeoutMs}ms waiting for the Prime Agent daemon response to "${pending.commandType}". ${daemonEndpointDetails(this.socketPath)}`
        )
      );
    }, pending.timeoutMs);
  }
  close() {
    this.closed = true;
    this.reconnectOptions = void 0;
    this.detachReader?.();
    this.detachReader = void 0;
    this.rejectAll(
      new Error(
        `Prime Agent daemon client closed before the operation completed. ${daemonEndpointDetails(this.socketPath)}`
      )
    );
    this.socket?.end();
    this.socket?.destroy();
    this.socket = void 0;
  }
  clearSocketReference(socket) {
    if (this.socket !== socket) {
      return;
    }
    this.detachReader?.();
    this.detachReader = void 0;
    this.socket = void 0;
  }
  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (isDaemonHello(message)) {
      this.helloMessage = message;
      for (const waiter of [...this.helloWaiters]) {
        clearTimeout(waiter.timeout);
        this.helloWaiters.delete(waiter);
        waiter.resolve(message);
      }
      if (this.socket && !this.socket.destroyed) {
        for (const [id, pending] of this.pendingRequests) {
          if (!pending.awaitingReconnect) {
            continue;
          }
          pending.awaitingReconnect = false;
          const missingCompatibility = pending.compatibilities.find(
            (compatibility) => !meetsDaemonCommandCompatibility(message, compatibility)
          );
          if (missingCompatibility) {
            this.pendingRequests.delete(id);
            pending.reject(
              new DaemonCapabilityUnavailableError(
                pending.commandType,
                missingCompatibility.capability,
                true
              )
            );
            continue;
          }
          this.armPendingRequestTimeout(id, pending);
          this.socket.write(pending.wireData);
        }
      }
    }
    if (isDaemonClosing(message)) {
      this.daemonClosingReason = message.reason;
    }
    if (isDaemonResponse(message) && message.id) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
        this.pendingRequests.delete(message.id);
        pending.resolve(message);
        if (pending.acknowledgeResult) {
          this.acknowledgeCommandResult(message.id);
        }
        return;
      }
    }
    if (isDaemonRequestProgress(message) && message.id) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        pending.onProgress?.(message);
        return;
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
      }
    }
  }
  acknowledgeCommandResult(commandId) {
    const hello = this.helloMessage;
    if (!this.socket || this.socket.destroyed || !hello || hello.protocol.version < DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION) {
      return;
    }
    const id = `daemon_ack_${++this.requestId}`;
    const command = { id, type: "ack_result", commandId };
    const protocolVersion = Math.min(hello.protocol.version, DAEMON_PROTOCOL_VERSION);
    this.socket.write(
      serializeJsonLine(createDaemonCommandEnvelope(command, id, this.protocolClientId, protocolVersion))
    );
  }
  rejectAll(error, preservePendingRequests = false) {
    for (const [id, pending] of this.pendingRequests) {
      if (preservePendingRequests && pending.recoverable) {
        if (pending.timeout) {
          clearTimeout(pending.timeout);
          pending.timeout = void 0;
        }
        pending.awaitingReconnect = true;
        continue;
      }
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
    for (const waiter of [...this.helloWaiters]) {
      clearTimeout(waiter.timeout);
      this.helloWaiters.delete(waiter);
      waiter.reject(error);
    }
  }
  notifyClosed(socket, error) {
    if (this.socket !== socket) {
      return;
    }
    this.clearSocketReference(socket);
    this.rejectAll(error, this.requestRecoveryEnabled);
    for (const listener of [...this.closeListeners]) {
      listener(error);
    }
    if (this.reconnectOptions && !this.closed) {
      void this.autoReconnect(error);
    }
  }
  async autoReconnect(cause) {
    if (this.autoReconnectPromise) {
      return this.autoReconnectPromise;
    }
    const options = this.reconnectOptions;
    if (!options || this.closed) {
      return;
    }
    this.emitReconnectStatus({ status: "reconnecting", error: cause.message });
    this.autoReconnectPromise = (async () => {
      const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS);
      let attempt = 0;
      let lastError = cause;
      while (!this.closed && this.reconnectOptions === options && Date.now() < deadline) {
        try {
          await options.recoverDaemon();
          if (this.closed || this.reconnectOptions !== options) {
            return;
          }
          await this.connect(RECONNECT_CONNECT_TIMEOUT_MS);
          await this.waitForHello(RECONNECT_HELLO_TIMEOUT_MS);
          this.emitReconnectStatus({ status: "connected" });
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          this.resetTransportForReconnect();
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            break;
          }
          const delayMs = Math.min(remainingMs, MAX_RECONNECT_DELAY_MS, 100 * 2 ** Math.min(attempt, 5));
          attempt++;
          await delay(delayMs);
        }
      }
      if (this.closed || this.reconnectOptions !== options) {
        return;
      }
      const failure = new Error(`Daemon reconnection failed: ${lastError.message}`);
      this.rejectAll(failure);
      this.emitReconnectStatus({ status: "failed", error: failure.message });
      this.reconnectOptions = void 0;
    })().finally(() => {
      this.autoReconnectPromise = void 0;
    });
    return this.autoReconnectPromise;
  }
  emitReconnectStatus(status) {
    try {
      this.reconnectOptions?.onStatus?.(status);
    } catch {
    }
  }
};
function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
function isDaemonClosing(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value;
  return candidate.type === "daemon_closing" && (candidate.reason === "shutdown" || candidate.reason === "update");
}
function isDaemonHello(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value;
  return candidate.type === "daemon_hello" && typeof candidate.protocol === "object" && candidate.protocol !== null;
}
function isDaemonResponse(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value;
  return candidate.type === "response" && typeof candidate.success === "boolean" && typeof candidate.command === "string";
}
function isDaemonRequestProgress(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value;
  if (candidate.command !== "list_saved_sessions" || typeof candidate.id !== "string") {
    return false;
  }
  if (candidate.type === "session_list_progress") {
    return typeof candidate.loaded === "number" && typeof candidate.total === "number";
  }
  return candidate.type === "session_list_item" && isDaemonSavedSessionInfo(candidate.session);
}
function isDaemonSavedSessionInfo(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value;
  return typeof candidate.path === "string" && typeof candidate.id === "string" && typeof candidate.cwd === "string" && typeof candidate.created === "string" && typeof candidate.modified === "string" && typeof candidate.messageCount === "number" && typeof candidate.firstMessage === "string" && typeof candidate.allMessagesText === "string" && (candidate.agentStatus === void 0 || isDaemonSavedSessionAgentStatus(candidate.agentStatus));
}
function isDaemonSavedSessionAgentStatus(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value;
  return typeof candidate.summary === "string" && typeof candidate.basedOnMessageCount === "number" && (candidate.taskState === void 0 || candidate.taskState === "needs_input" || candidate.taskState === "completed");
}

// packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// packages/coding-agent/src/core/session-lease.ts
var SessionAlreadyActiveError = class extends Error {
  constructor(sessionPath, activeSessionId) {
    super(
      activeSessionId ? `Session is already active in ${activeSessionId}: ${sessionPath}` : `Session is already active in another process: ${sessionPath}`
    );
    this.sessionPath = sessionPath;
    this.activeSessionId = activeSessionId;
    this.code = "session_already_active";
    this.name = "SessionAlreadyActiveError";
  }
};

// packages/coding-agent/src/modes/daemon/agent-roster.ts
function sessionSummaryFromRosterEntry(entry) {
  const ledger = "status" in entry ? entry : void 0;
  return {
    ...entry.summary,
    sessionActions: { queuedCount: 0, steering: [], followUps: [] },
    ...ledger ? { rosterStatus: ledger.status } : {},
    ...ledger?.statusLabel ? { statusLabel: ledger.statusLabel } : {},
    ...ledger?.lastHeardFromAt ? { lastHeardFromAt: ledger.lastHeardFromAt } : {}
  };
}

// packages/coding-agent/src/modes/agents-view/roster-store.ts
var STALE_ROSTER_DAEMON_MESSAGE = "Daemon is stale: it does not advertise the agent_roster capability; restart the daemon";
var AgentsViewRosterStore = class {
  constructor() {
    this.entries = /* @__PURE__ */ new Map();
    this.listeners = /* @__PURE__ */ new Set();
    this.emitScheduled = false;
    this.subscribed = false;
    this.attachChain = Promise.resolve();
  }
  async attach(client) {
    const run = () => this.attachToClient(client);
    const chained = this.attachChain.then(run, run);
    this.attachChain = chained;
    return chained;
  }
  async attachToClient(client) {
    if (client.isConnected && client.hello === void 0) await client.waitForHello();
    if (!client.supportsServerCapability("agent_roster")) {
      this.detachFromClient();
      return false;
    }
    const hello = client.hello;
    if (this.subscribed && this.client === client && client.isConnected && hello === this.subscribedHello) {
      return true;
    }
    this.detachFromClient();
    this.client = client;
    let pendingUpdates = [];
    this.unsubscribeMessage = client.onMessage((message) => {
      if (message.type !== "roster_update") return;
      if (pendingUpdates) pendingUpdates.push(message);
      else this.applyUpdate(message.changed, message.removed, message.resync);
    });
    let response;
    try {
      response = await client.request({ type: "roster_subscribe" }, 3e4, { recoverable: false });
    } catch (error) {
      this.detachFromClient();
      throw error;
    }
    if (!response.success || typeof response.data !== "object" || response.data === null) {
      this.detachFromClient();
      throw new Error(
        `roster_subscribe failed: ${response.success ? "invalid roster payload" : response.error ?? "unknown error"}`
      );
    }
    const roster = response.data.roster ?? [];
    this.applyUpdate(roster, void 0, true);
    for (const update of pendingUpdates ?? []) {
      this.applyUpdate(update.changed, update.removed, update.resync);
    }
    pendingUpdates = void 0;
    this.subscribed = true;
    this.subscribedHello = hello;
    return true;
  }
  applyUpdate(changed, removed, resync) {
    if (resync) this.entries.clear();
    for (const entry of changed) {
      this.entries.set(entry.agentId, entry);
    }
    for (const agentId of removed ?? []) {
      this.entries.delete(agentId);
    }
    this.scheduleEmit();
  }
  summaries() {
    return [...this.entries.values()].map((entry) => sessionSummaryFromRosterEntry(entry));
  }
  onUpdate(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  scheduleEmit() {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    queueMicrotask(() => {
      this.emitScheduled = false;
      for (const listener of [...this.listeners]) {
        try {
          listener();
        } catch {
        }
      }
    });
  }
  detachFromClient() {
    this.unsubscribeMessage?.();
    this.unsubscribeMessage = void 0;
    this.subscribed = false;
    this.subscribedHello = void 0;
    this.client = void 0;
  }
  async dispose() {
    const run = () => this.disposeNow();
    const chained = this.attachChain.then(run, run);
    this.attachChain = chained;
    return chained;
  }
  disposeNow() {
    const client = this.client;
    this.detachFromClient();
    this.listeners.clear();
    if (client?.isConnected) {
      void client.request({ type: "roster_unsubscribe" }).catch(() => void 0);
    }
  }
};

// packages/coding-agent/src/core/session-cwd.ts
function formatMissingSessionCwdError(issue) {
  const sessionFile = issue.sessionFile ? `
Session file: ${issue.sessionFile}` : "";
  return `Stored session working directory does not exist: ${issue.sessionCwd}${sessionFile}
Current working directory: ${issue.fallbackCwd}`;
}
var MissingSessionCwdError = class extends Error {
  constructor(issue) {
    super(formatMissingSessionCwdError(issue));
    this.name = "MissingSessionCwdError";
    this.issue = issue;
  }
};

// packages/coding-agent/src/core/session-import-errors.ts
var SessionImportFileNotFoundError = class extends Error {
  constructor(filePath) {
    super(`File not found: ${filePath}`);
    this.name = "SessionImportFileNotFoundError";
    this.filePath = filePath;
  }
};

// packages/coding-agent/src/modes/daemon/daemon-errors.ts
var DaemonSessionRecoveringError = class extends Error {
  constructor(activeSessionId) {
    super(`Active session ${activeSessionId} is recovering; retry shortly`);
    this.activeSessionId = activeSessionId;
    this.code = "session_recovering";
    this.name = "DaemonSessionRecoveringError";
  }
};
function deserializeDaemonError(response) {
  const { errorInfo } = response;
  if (errorInfo?.code === "missing_session_cwd") {
    return new MissingSessionCwdError(errorInfo.issue);
  }
  if (errorInfo?.code === "session_import_file_not_found") {
    return new SessionImportFileNotFoundError(errorInfo.filePath);
  }
  if (errorInfo?.code === "session_already_active") {
    return new SessionAlreadyActiveError(errorInfo.sessionPath, errorInfo.activeSessionId);
  }
  if (errorInfo?.code === "session_recovering") {
    return new DaemonSessionRecoveringError(errorInfo.activeSessionId);
  }
  return new Error(response.error);
}

// packages/coding-agent/src/modes/daemon/daemon-socket.ts
import { chmodSync, existsSync as existsSync2, lstatSync, mkdirSync as mkdirSync2, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";
function defaultDaemonSocketPath() {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\prime-agent-daemon";
  }
  return join2(defaultDaemonSocketDir(), "daemon.sock");
}
function getDaemonSocketIdentity(socketPath) {
  if (process.platform === "win32") {
    return void 0;
  }
  const stat = lstatSync(socketPath);
  return { dev: stat.dev, ino: stat.ino };
}
function defaultDaemonSocketDir() {
  const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join2(tmpdir(), `prime-agent-${suffix}`);
}

// packages/coding-agent/src/modes/daemon/daemon-worker-client.ts
import { createConnection as createConnection2 } from "node:net";

// packages/coding-agent/src/modes/session-worker/private-framing.ts
var FRAME_PREFIX_BYTES = 8;
var DEFAULT_PRIVATE_FRAME_LIMITS = {
  maxHeaderBytes: 1024 * 1024,
  maxPayloadBytes: 1024 * 1024 * 1024
};
function assertFrameLength(name, value, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`Invalid private frame ${name}: ${value}`);
  }
}
function isObjectHeader(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function encodePrivateFrame(header, payload = Buffer.alloc(0), limits = DEFAULT_PRIVATE_FRAME_LIMITS) {
  const headerBuffer = Buffer.from(JSON.stringify(header), "utf8");
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  assertFrameLength("header length", headerBuffer.length, limits.maxHeaderBytes);
  assertFrameLength("payload length", payloadBuffer.length, limits.maxPayloadBytes);
  if (headerBuffer.length === 0) {
    throw new Error("Private frame header cannot be empty");
  }
  const frame = Buffer.allocUnsafe(FRAME_PREFIX_BYTES + headerBuffer.length + payloadBuffer.length);
  frame.writeUInt32BE(headerBuffer.length, 0);
  frame.writeUInt32BE(payloadBuffer.length, 4);
  headerBuffer.copy(frame, FRAME_PREFIX_BYTES);
  payloadBuffer.copy(frame, FRAME_PREFIX_BYTES + headerBuffer.length);
  return frame;
}
var PrivateFrameDecoder = class {
  constructor(validateHeader, limits = DEFAULT_PRIVATE_FRAME_LIMITS) {
    this.validateHeader = validateHeader;
    this.limits = limits;
    this.buffered = Buffer.alloc(0);
  }
  get bufferedBytes() {
    return this.buffered.length;
  }
  push(chunk) {
    if (chunk.length > 0) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buffered = this.buffered.length === 0 ? buffer : Buffer.concat([this.buffered, buffer]);
    }
    const frames = [];
    let offset = 0;
    while (this.buffered.length - offset >= FRAME_PREFIX_BYTES) {
      const headerLength = this.buffered.readUInt32BE(offset);
      const payloadLength = this.buffered.readUInt32BE(offset + 4);
      assertFrameLength("header length", headerLength, this.limits.maxHeaderBytes);
      assertFrameLength("payload length", payloadLength, this.limits.maxPayloadBytes);
      if (headerLength === 0) {
        throw new Error("Private frame header cannot be empty");
      }
      const frameLength = FRAME_PREFIX_BYTES + headerLength + payloadLength;
      if (this.buffered.length - offset < frameLength) {
        break;
      }
      const headerStart = offset + FRAME_PREFIX_BYTES;
      const payloadStart = headerStart + headerLength;
      let decoded;
      try {
        decoded = JSON.parse(this.buffered.toString("utf8", headerStart, payloadStart));
      } catch (error) {
        throw new Error(
          `Invalid private frame header JSON: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (!isObjectHeader(decoded) || !this.validateHeader(decoded)) {
        throw new Error("Invalid private frame routing header");
      }
      frames.push({
        header: decoded,
        payload: Buffer.from(this.buffered.subarray(payloadStart, payloadStart + payloadLength))
      });
      offset += frameLength;
    }
    if (offset > 0) {
      this.buffered = Buffer.from(this.buffered.subarray(offset));
    }
    return frames;
  }
  finish() {
    if (this.buffered.length !== 0) {
      throw new Error(`Private frame channel ended with ${this.buffered.length} incomplete bytes`);
    }
  }
};
var PrivateFramedChannel = class {
  constructor(stream, validateHeader, limits = DEFAULT_PRIVATE_FRAME_LIMITS) {
    this.stream = stream;
    this.limits = limits;
    this.listeners = /* @__PURE__ */ new Set();
    this.closed = false;
    this.handleData = (chunk) => {
      try {
        for (const frame of this.decoder.push(chunk)) {
          for (const listener of this.listeners) {
            listener(frame);
          }
        }
      } catch (error) {
        this.stream.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    };
    this.handleEnd = () => {
      try {
        this.decoder.finish();
      } catch (error) {
        this.stream.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    };
    this.handleClose = () => {
      this.closed = true;
      this.detach();
    };
    this.decoder = new PrivateFrameDecoder(validateHeader, limits);
    stream.on("data", this.handleData);
    stream.on("end", this.handleEnd);
    stream.on("close", this.handleClose);
  }
  onFrame(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async send(header, payload) {
    if (this.closed || this.stream.destroyed) {
      throw new Error("Private frame channel is closed");
    }
    const frame = encodePrivateFrame(header, payload, this.limits);
    await new Promise((resolve3, reject) => {
      this.stream.write(frame, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve3();
        }
      });
    });
  }
  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.detach();
    this.stream.end();
  }
  detach() {
    this.stream.off("data", this.handleData);
    this.stream.off("end", this.handleEnd);
    this.stream.off("close", this.handleClose);
    this.listeners.clear();
  }
};

// packages/coding-agent/src/modes/daemon/daemon-worker-protocol.ts
function isDaemonWorkerFrameHeader(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value;
  if (candidate.kind === "command") {
    return typeof candidate.requestId === "string" && typeof candidate.commandType === "string";
  }
  return candidate.kind === "outbound" && typeof candidate.outboundType === "string" && (candidate.requestId === void 0 || typeof candidate.requestId === "string") && (candidate.activeSessionId === void 0 || typeof candidate.activeSessionId === "string") && (candidate.snapshotId === void 0 || typeof candidate.snapshotId === "string") && (candidate.sessionEventType === void 0 || typeof candidate.sessionEventType === "string") && (candidate.snapshotPurpose === void 0 || candidate.snapshotPurpose === "attach" || candidate.snapshotPurpose === "replacement" || candidate.snapshotPurpose === "catchup") && (candidate.payloadEncoding === void 0 || candidate.payloadEncoding === "jsonl" || candidate.payloadEncoding === "assistant-delta");
}

// packages/coding-agent/src/modes/daemon/daemon-worker-client.ts
var DaemonWorkerAuthenticationError = class extends Error {
};
var DaemonWorkerProbeTimeoutError = class extends Error {
};
var DaemonWorkerClient = class {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.frameListeners = /* @__PURE__ */ new Set();
    this.messageListeners = /* @__PURE__ */ new Set();
    this.closeListeners = /* @__PURE__ */ new Set();
    this.pending = /* @__PURE__ */ new Map();
    this.requestId = 0;
    this.directPeer = false;
    this.helloWaiters = /* @__PURE__ */ new Set();
  }
  get hello() {
    return this.helloMessage;
  }
  get isConnected() {
    return this.socket !== void 0 && !this.socket.destroyed;
  }
  supportsServerCapability(capability) {
    return this.helloMessage?.serverCapabilities?.includes(capability) === true;
  }
  async connect(timeoutMs = 3e3) {
    if (this.socket) {
      throw new Error("Daemon worker client is already connected");
    }
    const socket = createConnection2(this.socketPath);
    this.socket = socket;
    this.channel = new PrivateFramedChannel(socket, isDaemonWorkerFrameHeader);
    this.channel.onFrame((frame) => this.handleFrame(frame));
    await new Promise((resolve3, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error(`Timed out connecting to daemon worker socket: ${this.socketPath}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      const onConnect = () => {
        cleanup();
        resolve3();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    socket.on("error", (error) => this.notifyClosed(socket, this.directCloseError(error)));
    socket.on(
      "close",
      () => this.notifyClosed(socket, this.directCloseError(new Error("Daemon worker socket closed")))
    );
  }
  waitForHello(timeoutMs = 3e3) {
    if (this.helloMessage) {
      return Promise.resolve(this.helloMessage);
    }
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error("Daemon worker client is not connected"));
    }
    return new Promise((resolve3, reject) => {
      const waiter = {
        resolve: resolve3,
        reject,
        timeout: setTimeout(() => {
          this.helloWaiters.delete(waiter);
          reject(new DaemonWorkerProbeTimeoutError("Timed out waiting for daemon worker hello"));
        }, timeoutMs)
      };
      this.helloWaiters.add(waiter);
    });
  }
  onFrame(listener) {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }
  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  request(command, timeoutMs = 3e4, _options = {}) {
    return this.requestWire(command, timeoutMs);
  }
  requestWorker(command, timeoutMs = 3e4) {
    return this.requestWire(command, timeoutMs);
  }
  async authenticateWorker(token, owner, timeoutMs = 3e3) {
    const response = await this.requestWorker({ type: "worker_auth", token, ...owner }, timeoutMs);
    if (!response.success) {
      throw new DaemonWorkerAuthenticationError(response.error);
    }
    return response;
  }
  async authenticatePeer(ticket, timeoutMs = 3e3) {
    const response = await this.requestWire(
      {
        type: "peer_auth",
        grantId: ticket.grantId,
        token: ticket.token,
        workerInstanceId: ticket.workerInstanceId,
        purpose: ticket.purpose
      },
      timeoutMs
    );
    if (!response.success) {
      throw new Error(response.error);
    }
    this.directPeer = true;
  }
  close() {
    this.rejectAll(new Error("Daemon worker client closed"));
    this.channel?.close();
    this.channel = void 0;
    this.socket?.destroy();
    this.socket = void 0;
    this.directPeer = false;
    this.directClosingReason = void 0;
  }
  async requestWire(command, timeoutMs) {
    if (!this.channel || !this.socket || this.socket.destroyed) {
      throw new Error("Daemon worker client is not connected");
    }
    const id = `worker_${++this.requestId}`;
    const fullCommand = { ...command, id };
    const response = new Promise((resolve3, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new DaemonWorkerProbeTimeoutError(`Timed out waiting for daemon worker response to ${command.type}`)
        );
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve3, reject, timeout });
    });
    try {
      await this.channel.send(
        { kind: "command", requestId: id, commandType: command.type },
        Buffer.from(serializeJsonLine(fullCommand))
      );
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return response;
  }
  handleFrame(frame) {
    if (frame.header.kind !== "outbound") {
      return;
    }
    if (frame.header.outboundType === "response" && frame.header.requestId) {
      const pending = this.pending.get(frame.header.requestId);
      if (pending) {
        let response;
        try {
          response = JSON.parse(frame.payload.toString("utf8"));
        } catch (error) {
          clearTimeout(pending.timeout);
          this.pending.delete(frame.header.requestId);
          pending.reject(new Error(`Invalid daemon worker response: ${String(error)}`));
          return;
        }
        if (isDaemonResponse2(response)) {
          clearTimeout(pending.timeout);
          this.pending.delete(frame.header.requestId);
          pending.resolve(response);
          return;
        }
      }
    }
    if (frame.header.outboundType === "daemon_hello") {
      try {
        const parsed = JSON.parse(frame.payload.toString("utf8"));
        if (parsed.type === "daemon_hello") {
          this.helloMessage = parsed;
          for (const waiter of [...this.helloWaiters]) {
            clearTimeout(waiter.timeout);
            this.helloWaiters.delete(waiter);
            waiter.resolve(parsed);
          }
        }
      } catch {
      }
    }
    for (const listener of this.frameListeners) {
      listener(frame);
    }
    if (this.directPeer && frame.header.outboundType !== "daemon_hello" && frame.header.outboundType !== "response") {
      this.emitDirectOutbound(frame);
    }
  }
  /** A malformed outbound frame closes the direct link (the routed client falls back) instead of throwing into consumers. */
  emitDirectOutbound(frame) {
    if (frame.header.kind !== "outbound") return;
    let message;
    try {
      if (frame.header.payloadEncoding !== void 0 && frame.header.payloadEncoding !== "jsonl") {
        throw new Error(`Direct worker sent an unsupported payload encoding: ${frame.header.payloadEncoding}`);
      }
      const parsed = JSON.parse(frame.payload.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
        throw new Error("Direct worker sent an invalid outbound payload");
      }
      message = parsed;
    } catch (error) {
      const socket = this.socket;
      const directError = this.directCloseError(error instanceof Error ? error : new Error(String(error)));
      if (socket) {
        this.notifyClosed(socket, directError);
        socket.destroy(directError);
      }
      return;
    }
    if (message.type === "daemon_closing") {
      this.directClosingReason = message.reason;
    }
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }
  directCloseError(cause) {
    return this.directPeer ? new DaemonSocketClosedError(this.socketPath, this.directClosingReason, cause.message) : cause;
  }
  rejectAll(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const waiter of [...this.helloWaiters]) {
      clearTimeout(waiter.timeout);
      this.helloWaiters.delete(waiter);
      waiter.reject(error);
    }
  }
  notifyClosed(socket, error) {
    if (this.socket !== socket) {
      return;
    }
    this.socket = void 0;
    this.channel = void 0;
    this.directPeer = false;
    this.directClosingReason = void 0;
    this.rejectAll(error);
    for (const listener of [...this.closeListeners]) {
      listener(error);
    }
  }
};
function isDaemonResponse2(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value;
  return candidate.type === "response" && typeof candidate.command === "string" && typeof candidate.success === "boolean";
}

// packages/coding-agent/src/modes/daemon/daemon-routed-client.ts
var DaemonDirectTransportClosedError = class extends DaemonSocketClosedError {
  constructor(cause) {
    super("direct-worker", getDaemonSocketCloseReason(cause), cause.message);
    this.name = "DaemonDirectTransportClosedError";
  }
};
var DaemonControlPlaneTransportError = class extends Error {
  constructor(cause) {
    super(`Daemon control-plane transport failed: ${cause.message}`, { cause });
    this.name = "DaemonControlPlaneTransportError";
  }
};
var DaemonRoutedClient = class {
  constructor(supervisor, direct) {
    this.supervisor = supervisor;
    this.messageListeners = /* @__PURE__ */ new Set();
    this.closeListeners = /* @__PURE__ */ new Set();
    this.closed = false;
    this.direct = direct;
    this.unsubscribeSupervisorMessage = supervisor.onMessage((message) => this.emitMessage(message));
    this.unsubscribeSupervisorClose = supervisor.onClose((error) => {
      if (!this.closed) this.emitClose(error);
    });
    this.bindDirect(direct);
  }
  get hello() {
    return this.supervisor.hello ?? this.direct?.hello;
  }
  get isConnected() {
    return this.supervisor.isConnected || this.direct?.isConnected === true;
  }
  get hasDirectTransport() {
    return this.direct?.isConnected === true;
  }
  get controlPlaneTransport() {
    return this.supervisor;
  }
  get isControlPlaneReady() {
    return this.supervisor.isConnected && this.supervisor.hello !== void 0;
  }
  supportsServerCapability(capability) {
    return this.supervisor.supportsServerCapability(capability) || this.direct?.supportsServerCapability(capability) === true;
  }
  waitForHello(timeoutMs = 3e3) {
    return this.supervisor.waitForHello(timeoutMs);
  }
  async connect(timeoutMs = 3e3) {
    if (!this.supervisor.isConnected) await this.supervisor.connect(timeoutMs);
  }
  async reconnect(timeoutMs = 3e3) {
    if (!this.supervisor.isConnected) await this.supervisor.reconnect(timeoutMs);
  }
  disconnectForReconnect(reason) {
    this.fallbackToSupervisor();
    this.supervisor.disconnectForReconnect(reason);
  }
  resetTransportForReconnect() {
    this.supervisor.resetTransportForReconnect();
  }
  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  enableRequestRecovery() {
    this.supervisor.enableRequestRecovery();
  }
  request(command, timeoutMs = 3e4, options = {}) {
    if (command.type === "reattach") {
      return this.requestControlPlane(command, timeoutMs, options).then((response) => {
        if (response.success) this.fallbackToSupervisor();
        return response;
      });
    }
    const direct = this.direct;
    if (direct?.isConnected && this.servesDirect(direct, command)) {
      return direct.request(command, timeoutMs, options);
    }
    return this.requestControlPlane(command, timeoutMs, options);
  }
  servesDirect(direct, command) {
    if (!isSessionPlaneDaemonCommand(command.type)) return false;
    const hello = direct.hello;
    if (!hello) return false;
    return getDaemonCommandCompatibilities(command).every(
      (compatibility) => meetsDaemonCommandCompatibility(hello, compatibility)
    );
  }
  requestControlPlane(command, timeoutMs, options) {
    return this.supervisor.request(command, timeoutMs, options).catch((error) => {
      if (error instanceof DaemonCapabilityUnavailableError) throw error;
      throw new DaemonControlPlaneTransportError(error instanceof Error ? error : new Error(String(error)));
    });
  }
  fallbackToSupervisor() {
    const direct = this.direct;
    if (!direct) return;
    this.direct = void 0;
    this.unsubscribeDirectMessage?.();
    this.unsubscribeDirectMessage = void 0;
    this.unsubscribeDirectClose?.();
    this.unsubscribeDirectClose = void 0;
    direct.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.fallbackToSupervisor();
    this.unsubscribeSupervisorMessage();
    this.unsubscribeSupervisorClose();
    this.supervisor.close();
    this.messageListeners.clear();
    this.closeListeners.clear();
  }
  bindDirect(direct) {
    this.unsubscribeDirectMessage = direct.onMessage((message) => this.emitMessage(message));
    this.unsubscribeDirectClose = direct.onClose((error) => {
      if (this.closed || this.direct !== direct) return;
      this.direct = void 0;
      this.unsubscribeDirectMessage?.();
      this.unsubscribeDirectMessage = void 0;
      this.unsubscribeDirectClose = void 0;
      this.emitClose(new DaemonDirectTransportClosedError(error));
    });
  }
  emitMessage(message) {
    for (const listener of [...this.messageListeners]) listener(message);
  }
  emitClose(error) {
    for (const listener of [...this.closeListeners]) listener(error);
  }
};
async function createDaemonSessionTransport(supervisor, activeSessionId, directDisabled) {
  if (directDisabled || supervisor instanceof DaemonRoutedClient || !supervisor.supportsServerCapability("direct_peer_transport")) {
    return supervisor;
  }
  let direct;
  try {
    const response = await supervisor.request({ type: "get_direct_worker_transport", activeSessionId }, 5e3, {
      recoverable: false
    });
    if (!response.success) return supervisor;
    const ticket = readSessionTransportTicket(response.data);
    if (!ticket || ticket.activeSessionId !== activeSessionId || Date.parse(ticket.expiresAt) <= Date.now()) {
      return supervisor;
    }
    const currentIdentity = getDaemonSocketIdentity(ticket.socketPath);
    if (!currentIdentity || currentIdentity.dev !== ticket.socketIdentity.dev || currentIdentity.ino !== ticket.socketIdentity.ino) {
      return supervisor;
    }
    direct = new DaemonWorkerClient(ticket.socketPath);
    await direct.connect(1e3);
    await direct.waitForHello();
    await direct.authenticatePeer(ticket);
    return new DaemonRoutedClient(supervisor, direct);
  } catch {
    direct?.close();
    return supervisor;
  }
}
function readSessionTransportTicket(value) {
  if (!value || typeof value !== "object") return void 0;
  const candidate = value;
  if (candidate.purpose !== "session_client" || typeof candidate.socketPath !== "string" || typeof candidate.workerInstanceId !== "string" || typeof candidate.activeSessionId !== "string" || typeof candidate.grantId !== "string" || typeof candidate.token !== "string" || typeof candidate.expiresAt !== "string") {
    return void 0;
  }
  if (!candidate.socketIdentity || typeof candidate.socketIdentity.dev !== "number" || typeof candidate.socketIdentity.ino !== "number") {
    return void 0;
  }
  return candidate;
}

// packages/coding-agent/src/modes/daemon/heartbeat-catalog.ts
async function listDaemonHeartbeats(client, activeSessionId) {
  if (!client.hello) await client.waitForHello();
  if (!client.supportsServerCapability("heartbeat_catalog")) return [];
  try {
    const command = { type: "heartbeats_list", ...activeSessionId ? { activeSessionId } : {} };
    const response = await client.request(command);
    if (!response.success) {
      throw deserializeDaemonError(response);
    }
    return response.data.heartbeats;
  } catch (error) {
    if (isUnknownDaemonCommandError(error, "heartbeats_list")) {
      return [];
    }
    throw error;
  }
}

// packages/coding-agent/src/modes/daemon/saved-session-info.ts
function deserializeSavedSessionInfo(session) {
  return {
    path: session.path,
    id: session.id,
    cwd: session.cwd,
    name: session.name,
    state: session.state,
    parentSessionPath: session.parentSessionPath,
    rlmDepth: session.rlmDepth,
    created: new Date(session.created),
    modified: new Date(session.modified),
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
    allMessagesText: session.allMessagesText,
    agentStatus: session.agentStatus,
    usage: session.usage,
    model: session.model
  };
}

// packages/coding-agent/src/modes/daemon/saved-session-catalog.ts
async function listDaemonSavedSessions(client, context, scope, callbacks) {
  const command = "activeSessionId" in context ? { type: "list_saved_sessions", activeSessionId: context.activeSessionId, scope } : { type: "list_saved_sessions", cwd: context.cwd, sessionDir: context.sessionDir, scope };
  const response = await client.request(command, 3e4, {
    onProgress: (update) => {
      if (update.type === "session_list_progress") {
        callbacks?.onProgress?.(update.loaded, update.total);
      } else {
        callbacks?.onSession?.(deserializeSavedSessionInfo(update.session));
      }
    }
  });
  if (!response.success) {
    throw deserializeDaemonError(response);
  }
  const data = response.data;
  return data.sessions.map(deserializeSavedSessionInfo);
}
async function renameDaemonSavedSession(client, context, sessionPath, name) {
  const command = "activeSessionId" in context ? { type: "rename_saved_session", activeSessionId: context.activeSessionId, sessionPath, name } : { type: "rename_saved_session", sessionPath, name };
  const response = await client.request(command);
  if (!response.success) {
    throw deserializeDaemonError(response);
  }
}
async function deleteDaemonSavedSession(client, context, sessionPath) {
  const command = "activeSessionId" in context ? { type: "delete_saved_session", activeSessionId: context.activeSessionId, sessionPath } : { type: "delete_saved_session", sessionPath };
  const response = await client.request(command);
  if (!response.success) {
    throw deserializeDaemonError(response);
  }
  return response.data;
}

// packages/coding-agent/src/modes/agent-connection/types.ts
var AgentConnectionPromptAdmissionError = class extends Error {
  constructor(message, status, options) {
    super(message, options);
    this.status = status;
    this.cancelled = status === "cancelled";
    this.name = "AgentConnectionPromptAdmissionError";
  }
};

// packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts
var DAEMON_REFINE_REQUEST_TIMEOUT_MS = 10 * 60 * 1e3;
var DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1e3;
var DAEMON_RECONNECT_TIMEOUT_MS = 6e4;
var DAEMON_SNAPSHOT_TIMEOUT_MS = 3e4;
var MAX_IGNORED_SNAPSHOT_IDS = 128;
var UPDATE_RECONNECT_TIMEOUT_MS = 12e4;
var UPDATE_RECONNECT_RETRY_MS = 100;
var MAX_COMPLETED_SNAPSHOTS = 128;
var OWNED_SESSION_DISPOSE_RECONNECT_WAIT_MS = 1e4;
var updateTransportReconnects = /* @__PURE__ */ new WeakMap();
function delay2(ms) {
  return new Promise((resolve3) => setTimeout(resolve3, ms));
}
function formatErrorSentence(error) {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  if (!message) {
    return "Unknown daemon error.";
  }
  return /[.!?]$/.test(message) ? message : `${message}.`;
}
function reconnectDaemonTransportAfterUpdate(client) {
  const existing = updateTransportReconnects.get(client);
  if (existing) {
    return existing;
  }
  const reconnectPromise = Promise.resolve().then(async () => {
    client.disconnectForReconnect("update");
    const deadline = Date.now() + UPDATE_RECONNECT_TIMEOUT_MS;
    let lastError;
    while (Date.now() < deadline) {
      try {
        await client.reconnect(1e3);
        return;
      } catch (error) {
        lastError = error;
      }
      await delay2(UPDATE_RECONNECT_RETRY_MS);
    }
    throw lastError ?? new Error("the updated daemon did not become available");
  }).finally(() => {
    if (updateTransportReconnects.get(client) === reconnectPromise) {
      updateTransportReconnects.delete(client);
    }
  });
  updateTransportReconnects.set(client, reconnectPromise);
  return reconnectPromise;
}
function buildSessionTreeFromFlatNodes(flatNodes) {
  const byId = /* @__PURE__ */ new Map();
  const roots = [];
  for (const flatNode of flatNodes) {
    byId.set(flatNode.entry.id, { ...flatNode, children: [] });
  }
  for (const flatNode of flatNodes) {
    const entry = flatNode.entry;
    const node = byId.get(entry.id);
    const parent = entry.parentId === null || entry.parentId === entry.id ? void 0 : byId.get(entry.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  for (const node of byId.values()) {
    node.children.sort(
      (left, right) => new Date(left.entry.timestamp).getTime() - new Date(right.entry.timestamp).getTime()
    );
  }
  return roots;
}
var DaemonAgentConnection = class _DaemonAgentConnection {
  constructor(client, activeSessionId, options = {}) {
    this.client = client;
    this.activeSessionId = activeSessionId;
    this.options = options;
    this.listeners = /* @__PURE__ */ new Set();
    this.clientId = `daemon-agent-connection:${randomUUID2()}`;
    this.sessionInputPauses = /* @__PURE__ */ new Map();
    this.sessionInputPauseGeneration = 0;
    this.ownedSessionPromotionTail = Promise.resolve();
    this.retiredEventGenerations = /* @__PURE__ */ new Set();
    this.latestSnapshotIsFresh = false;
    this.updateRestartPending = false;
    this.updateReconnectFailed = false;
    this.terminalCloseEmitted = false;
    this.activeSideQuestionIds = /* @__PURE__ */ new Set();
    this.snapshotAssemblies = /* @__PURE__ */ new Map();
    this.completedSnapshots = /* @__PURE__ */ new Map();
    this.pendingReattachActiveSessionIds = /* @__PURE__ */ new Set();
    this.snapshotRecoveryPromises = /* @__PURE__ */ new Map();
    this.ignoredSnapshotIds = /* @__PURE__ */ new Set();
    this.initialAttachPending = false;
    this.definitiveRequestErrors = /* @__PURE__ */ new WeakSet();
    this.disposing = false;
    this.disposed = false;
    if (options.recoverDaemon) {
      this.client.enableRequestRecovery();
    }
    this.unsubscribeDaemonMessages = this.client.onMessage((message) => {
      void this.handleDaemonMessage(message).catch((error) => {
        try {
          appendRotatingLog(
            getAgentLogPath(),
            `[${(/* @__PURE__ */ new Date()).toISOString()}] daemon-message: ignored ${message.type} failure: ${String(error)}`
          );
        } catch {
        }
      });
    });
    this.captureDaemonLogPath();
    this.unsubscribeDaemonClose = this.client.onClose((error) => this.handleTransportClose(error));
  }
  handleTransportClose(error) {
    const directSessionSurvives = this.client instanceof DaemonRoutedClient && this.client.hasDirectTransport && !(error instanceof DaemonDirectTransportClosedError);
    const invalidatedInputPause = !directSessionSurvives && this.sessionInputPauses.size > 0;
    if (!directSessionSurvives) {
      this.sessionInputPauses.clear();
      this.sessionInputPauseGeneration++;
      this.rejectSnapshotAssemblies(error);
    }
    if (this.initialAttachPending) {
      if (directSessionSurvives) this.initialControlPlaneClose = error;
      return;
    }
    if (this.disposed || this.terminalCloseEmitted) {
      return;
    }
    if (invalidatedInputPause && !(error instanceof DaemonDirectTransportClosedError)) {
      this.terminalCloseEmitted = true;
      void this.emit({
        type: "closed",
        error: "Daemon connection closed while session input was paused; the fence was invalidated."
      });
      return;
    }
    const closeReason = getDaemonSocketCloseReason(error);
    if (closeReason === "shutdown") {
      this.terminalCloseEmitted = true;
      void this.emit({ type: "closed", error: this.formatDaemonSessionClosedError("shutdown") });
      return;
    }
    if ((this.updateRestartPending || closeReason === "update") && !this.updateReconnectFailed) {
      this.updateRestartPending = true;
      void this.reconnectAfterUpdate();
      return;
    }
    if (directSessionSurvives || error instanceof DaemonDirectTransportClosedError || this.options.recoverDaemon) {
      void this.reconnect(error);
      return;
    }
    this.terminalCloseEmitted = true;
    void this.emit({ type: "closed", error: this.formatDaemonConnectionClosedError(error) });
  }
  static async attach(client, activeSessionId, options) {
    const transport = await createDaemonSessionTransport(
      client,
      activeSessionId,
      options?.ownedSession === true || options?.directTransport === false
    );
    const connection = new _DaemonAgentConnection(transport, activeSessionId, options);
    connection.initialAttachPending = true;
    try {
      try {
        await connection.attach();
      } catch (error) {
        if (!(transport instanceof DaemonRoutedClient)) throw error;
        transport.fallbackToSupervisor();
        try {
          await connection.attach({ recoverable: false });
        } catch (retryError) {
          throw connection.initialControlPlaneClose ?? retryError;
        }
      }
      connection.initialAttachPending = false;
      const initialControlPlaneClose = connection.initialControlPlaneClose;
      connection.initialControlPlaneClose = void 0;
      if (initialControlPlaneClose) {
        if (getDaemonSocketCloseReason(initialControlPlaneClose) === "shutdown") {
          throw initialControlPlaneClose;
        }
        connection.handleTransportClose(initialControlPlaneClose);
      }
      return connection;
    } catch (error) {
      connection.initialAttachPending = false;
      await connection.dispose();
      throw error;
    }
  }
  async attach(options) {
    const supportsExtensionUi = this.options.supportsExtensionUi !== false;
    const result = await this.requestData(
      {
        type: "attach",
        activeSessionId: this.activeSessionId,
        supportsExtensionUi,
        clientId: this.clientId,
        capabilities: [
          "attach_snapshot",
          "event_sequence",
          ...supportsExtensionUi ? ["extension_ui"] : [],
          "slim_attach",
          "chunked_snapshot",
          ...this.options.ownedSession ? ["client_owned_sessions"] : []
        ],
        env: this.options.sendClientEnv ? collectDaemonClientEnv() : void 0,
        launchEnv: this.options.ownedSession ? collectDaemonLaunchEnv() : void 0,
        ...this.options.ownedSession && this.options.ownedSessionRecoveryConfig && this.client.supportsServerCapability("owned_session_recovery_context") ? { recoveryConfig: this.options.ownedSessionRecoveryConfig } : {},
        telemetryDisabled: this.options.telemetryDisabled,
        resumeCursor: this.lastEventCursor === void 0 ? void 0 : {
          activeSessionId: this.activeSessionId,
          ...this.lastEventCursor
        }
      },
      void 0,
      options
    );
    this.activeSessionId = getAttachActiveSessionId(result);
    const summary = "snapshot" in result ? result.snapshot.summary : result;
    this.attachedSessionId = summary.sessionId;
    this.attachedSessionFile = summary.sessionFile ?? ("snapshot" in result ? result.snapshot.state.sessionFile : void 0);
    this.captureDaemonLogPath();
    this.updateReconnectFailed = false;
    this.terminalCloseEmitted = false;
    const attachCursor = getAttachLastEventCursor(result);
    if (attachCursor) {
      this.observeEventCursor(attachCursor);
    }
    this.lastEventSequence = maxEventSequence(this.lastEventSequence, getAttachLastEventSequence(result));
    if ("snapshot" in result) {
      const snapshot = result.snapshotStream ? await this.waitForSnapshot(result.snapshotStream.id) : result.snapshot;
      this.latestSnapshot = mapDaemonSessionSnapshot(snapshot, result.replay);
      if (Array.isArray(snapshot.children)) this.childRosterSequence = snapshot.lastEventSequence;
      if (this.lastEventSequence !== void 0) {
        this.latestSnapshot.lastEventSequence = this.lastEventSequence;
      }
      if (this.lastEventCursor) {
        this.latestSnapshot.lastEventCursor = this.lastEventCursor;
      }
      this.latestSnapshotIsFresh = true;
    } else {
      this.latestSnapshot = void 0;
      this.latestSnapshotIsFresh = false;
    }
    if (this.rosterStore) await this.rosterStore.attach(this.client).catch(() => void 0);
  }
  async subscribeAgentRoster(listener) {
    this.rosterStore ??= new AgentsViewRosterStore();
    const store = this.rosterStore;
    if (!await store.attach(this.client)) {
      throw new Error(STALE_ROSTER_DAEMON_MESSAGE);
    }
    const unsubscribe = store.onUpdate(listener);
    return {
      summaries: () => store.summaries(),
      dispose: async () => unsubscribe()
    };
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onBeforeSessionInvalidate(_listener) {
    return () => {
    };
  }
  async getState() {
    if (this.latestSnapshotIsFresh && this.latestSnapshot) {
      return this.latestSnapshot.state;
    }
    return this.requestData({
      type: "get_connection_state",
      activeSessionId: this.activeSessionId
    });
  }
  async getInitialSnapshot(options) {
    if (this.latestSnapshotIsFresh && this.latestSnapshot) {
      return this.latestSnapshot;
    }
    const snapshotCursor = this.lastEventCursor;
    const snapshotSequence = this.lastEventSequence;
    const [state, messagesData, sessionContextData] = await Promise.all([
      this.requestData(
        { type: "get_connection_state", activeSessionId: this.activeSessionId },
        void 0,
        options
      ),
      this.requestData(
        { type: "get_messages", activeSessionId: this.activeSessionId },
        void 0,
        options
      ),
      this.requestData(
        { type: "get_session_context", activeSessionId: this.activeSessionId },
        void 0,
        options
      )
    ]);
    const children = this.latestSnapshot?.children;
    const streamingMessage = this.latestSnapshot?.streamingMessage;
    this.latestSnapshot = {
      state,
      messages: messagesData.messages,
      sessionContext: sessionContextData.context,
      ...children ? { children } : {},
      ...streamingMessage ? { streamingMessage } : {}
    };
    if (snapshotSequence !== void 0) {
      this.latestSnapshot.lastEventSequence = snapshotSequence;
    }
    if (snapshotCursor) {
      this.latestSnapshot.lastEventCursor = snapshotCursor;
    }
    this.latestSnapshotIsFresh = snapshotSequence === this.lastEventSequence && snapshotCursor?.generation === this.lastEventCursor?.generation && snapshotCursor?.sequence === this.lastEventCursor?.sequence;
    return this.latestSnapshot;
  }
  async getRlmChildSnapshots() {
    if (!this.client.supportsServerCapability("authoritative_child_roster")) {
      throw new DaemonCapabilityUnavailableError("get_rlm_children", "authoritative_child_roster");
    }
    const data = await this.requestData({ type: "get_rlm_children", activeSessionId: this.activeSessionId });
    if (!Array.isArray(data.children) || !Number.isInteger(data.eventSequence)) {
      throw new Error("Daemon returned an invalid child roster");
    }
    if ((this.childRosterSequence ?? -1) > data.eventSequence) {
      return this.latestSnapshot?.children ?? data.children;
    }
    this.childRosterSequence = data.eventSequence;
    if (this.latestSnapshot) {
      this.latestSnapshot = { ...this.latestSnapshot, children: data.children };
    }
    return data.children;
  }
  async getMessages() {
    if (this.latestSnapshotIsFresh && this.latestSnapshot) {
      return this.latestSnapshot.messages;
    }
    const data = await this.requestData({
      type: "get_messages",
      activeSessionId: this.activeSessionId
    });
    return data.messages;
  }
  async getSessionHeader() {
    const data = await this.requestData({
      type: "get_session_header",
      activeSessionId: this.activeSessionId
    });
    return data.header ?? void 0;
  }
  async getCommands() {
    const data = await this.requestData({
      type: "get_commands",
      activeSessionId: this.activeSessionId
    });
    return data.commands;
  }
  async getResourceSnapshot() {
    return this.requestData({
      type: "get_resource_snapshot",
      activeSessionId: this.activeSessionId
    });
  }
  supportsAcpMcpServers() {
    return this.client.supportsServerCapability("acp_mcp_servers");
  }
  async replaceAcpMcpServers(servers, ownerId) {
    if (!this.supportsAcpMcpServers()) {
      throw new DaemonCapabilityUnavailableError("replace_acp_mcp_servers", "acp_mcp_servers");
    }
    await this.requestOk({
      type: "replace_acp_mcp_servers",
      activeSessionId: this.activeSessionId,
      ownerId,
      servers: [...servers]
    });
  }
  async releaseAcpMcpServers(ownerId, _serverNames) {
    await this.replaceAcpMcpServers([], ownerId);
  }
  async getAvailableModels() {
    const data = await this.requestData({
      type: "get_available_models",
      activeSessionId: this.activeSessionId
    });
    return data.models;
  }
  async getModelCatalog() {
    if (!this.client.supportsServerCapability("model_catalog")) {
      const models = await this.getAvailableModels();
      return {
        models,
        configuredProviders: [...new Set(models.map((model) => model.provider))]
      };
    }
    return this.requestData({
      type: "get_model_catalog",
      activeSessionId: this.activeSessionId
    });
  }
  async getSessionStats() {
    return this.requestData({
      type: "get_session_stats",
      activeSessionId: this.activeSessionId
    });
  }
  async getContextTree() {
    return this.requestData({
      type: "get_context_tree",
      activeSessionId: this.activeSessionId
    });
  }
  async getSessionContext() {
    if (this.latestSnapshotIsFresh && this.latestSnapshot?.sessionContext) {
      return this.latestSnapshot.sessionContext;
    }
    const data = await this.requestData({
      type: "get_session_context",
      activeSessionId: this.activeSessionId
    });
    return data.context;
  }
  async getSessionTree() {
    if (this.latestSnapshotIsFresh && this.latestSnapshot?.sessionTree) {
      return this.latestSnapshot.sessionTree;
    }
    const data = await this.requestData({
      type: "get_session_tree",
      activeSessionId: this.activeSessionId
    });
    return { tree: buildSessionTreeFromFlatNodes(data.flatNodes), leafId: data.leafId };
  }
  async listSavedSessions(scope, callbacks) {
    return listDaemonSavedSessions(this.client, { activeSessionId: this.activeSessionId }, scope, callbacks);
  }
  async getQueue() {
    return this.requestData({
      type: "get_queue",
      activeSessionId: this.activeSessionId
    });
  }
  async mutateQueuedMessage(lane, index, expectedText, mutation) {
    if (!this.client.supportsServerCapability("queue_message_mutation")) return "unsupported";
    const data = await this.requestData({
      type: "mutate_queued_message",
      activeSessionId: this.activeSessionId,
      lane,
      index,
      expectedText,
      mutation
    });
    return data.status;
  }
  async clearQueue() {
    return this.requestData({
      type: "clear_queue",
      activeSessionId: this.activeSessionId
    });
  }
  async abortAndClearQueue() {
    try {
      return await this.requestData({
        type: "abort_and_clear_queue",
        activeSessionId: this.activeSessionId
      });
    } catch (error) {
      if (isUnknownDaemonCommandError(error, "abort_and_clear_queue")) {
        throw new Error("the daemon is running an older build; restart the daemon and try again");
      }
      throw error;
    }
  }
  async acquireSessionInputPause(leaseKey) {
    if (this.terminalCloseEmitted) throw new Error("Daemon connection is closed; cannot acquire an input pause.");
    const activeSessionId = this.activeSessionId;
    const generation = this.sessionInputPauseGeneration;
    const acquisitionKey = JSON.stringify([activeSessionId, leaseKey]);
    const existing = this.sessionInputPauses.get(acquisitionKey);
    if (existing) return existing;
    const acquisition = (async () => {
      const { pauseId } = await this.requestData({
        type: "acquire_session_input_pause",
        activeSessionId,
        leaseKey
      });
      if (generation !== this.sessionInputPauseGeneration || this.terminalCloseEmitted) {
        try {
          await this.requestData({
            type: "release_session_input_pause",
            activeSessionId,
            pauseId
          });
        } catch {
          this.client.close();
        }
        throw new Error("Session input pause acquisition was invalidated by a daemon reconnect.");
      }
      let released = false;
      return {
        release: async () => {
          if (released) return;
          if (generation !== this.sessionInputPauseGeneration) {
            throw new Error("Session input pause was invalidated by a daemon reconnect.");
          }
          await this.requestData({
            type: "release_session_input_pause",
            activeSessionId,
            pauseId
          });
          released = true;
          if (this.sessionInputPauses.get(acquisitionKey) === acquisition) {
            this.sessionInputPauses.delete(acquisitionKey);
          }
        }
      };
    })();
    this.sessionInputPauses.set(acquisitionKey, acquisition);
    try {
      return await acquisition;
    } catch (error) {
      if (this.sessionInputPauses.get(acquisitionKey) === acquisition)
        this.sessionInputPauses.delete(acquisitionKey);
      throw error;
    }
  }
  async listCronJobs(options = {}) {
    const data = await this.requestData({
      type: "cron_list",
      activeSessionId: this.activeSessionId,
      includeInactive: options.includeInactive
    });
    return data.jobs;
  }
  async listHeartbeats() {
    return listDaemonHeartbeats(this.client, this.options.ownedSession ? this.activeSessionId : void 0);
  }
  async manageHeartbeat(activeSessionId, jobId, action) {
    if (!this.client.supportsServerCapability("heartbeat_management")) {
      throw new Error("Heartbeat management requires a newer Prime Agent daemon.");
    }
    try {
      const data = await this.requestData({
        type: "heartbeat_manage",
        activeSessionId,
        jobId,
        action
      });
      return data.heartbeat;
    } catch (error) {
      if (isUnknownDaemonCommandError(error, "heartbeat_manage")) {
        throw new Error("Heartbeat management requires a newer Prime Agent daemon.");
      }
      throw error;
    }
  }
  async addCronJob(schedule, prompt) {
    return this.withOwnedSessionPromotion(async (promoteOwnedSession) => {
      const data = await this.requestData({
        type: "cron_add",
        activeSessionId: this.activeSessionId,
        schedule,
        prompt,
        promoteOwnedSession
      });
      return data.job;
    });
  }
  async cancelCronJob(jobId) {
    const data = await this.requestData({
      type: "cron_cancel",
      activeSessionId: this.activeSessionId,
      jobId
    });
    return data.job;
  }
  async getHeartbeat() {
    const data = await this.requestData({
      type: "heartbeat_get",
      activeSessionId: this.activeSessionId
    });
    return data.heartbeat ?? void 0;
  }
  async setHeartbeat(schedule, instruction, deliveryMode) {
    return this.withOwnedSessionPromotion(async (promoteOwnedSession) => {
      const data = await this.requestData({
        type: "heartbeat_set",
        activeSessionId: this.activeSessionId,
        schedule,
        prompt: instruction,
        ...deliveryMode ? { deliveryMode } : {},
        promoteOwnedSession
      });
      return data.heartbeat;
    });
  }
  async updateHeartbeat(action) {
    const data = await this.requestData({
      type: "heartbeat_update",
      activeSessionId: this.activeSessionId,
      action
    });
    return data.heartbeat ?? void 0;
  }
  async sendAgentMessage(targetActiveSessionId, message) {
    return this.requestData({
      type: "send_message",
      targetActiveSessionId,
      message,
      fromActiveSessionId: this.activeSessionId
    });
  }
  async getAgentMessageStatus() {
    return this.requestData({
      type: "agent_messages_status",
      activeSessionId: this.activeSessionId
    });
  }
  async pauseAgentMessages() {
    return this.requestData({
      type: "agent_messages_pause",
      activeSessionId: this.activeSessionId
    });
  }
  async resumeAgentMessages() {
    return this.requestData({
      type: "agent_messages_resume",
      activeSessionId: this.activeSessionId
    });
  }
  async clearAgentMessages() {
    return this.requestData({
      type: "agent_messages_clear",
      activeSessionId: this.activeSessionId
    });
  }
  async getUserMessagesForForking() {
    const data = await this.requestData({
      type: "get_user_messages_for_forking",
      activeSessionId: this.activeSessionId
    });
    return data.messages;
  }
  async getLastAssistantText() {
    const data = await this.requestData({
      type: "get_last_assistant_text",
      activeSessionId: this.activeSessionId
    });
    return data.text ?? void 0;
  }
  async getSystemPrompt() {
    const data = await this.requestData({
      type: "get_system_prompt",
      activeSessionId: this.activeSessionId
    });
    return data.systemPrompt;
  }
  async getToolDefinition(name) {
    const data = await this.requestData({
      type: "get_tool_definition",
      activeSessionId: this.activeSessionId,
      name
    });
    return data.toolDefinition;
  }
  async setSessionEntryLabel(entryId, label) {
    await this.requestOk({
      type: "set_session_entry_label",
      activeSessionId: this.activeSessionId,
      entryId,
      label
    });
  }
  async respondToExtensionUiRequest(requestId, response) {
    await this.requestOk({
      type: "extension_ui_response",
      activeSessionId: this.activeSessionId,
      requestId,
      response
    });
  }
  async prompt(message, options) {
    await this.promptWithAdmissionCancellation("prompt", message, options);
  }
  async promptAndWait(message, options) {
    await this.promptWithAdmissionCancellation("prompt_and_wait", message, options);
  }
  async promptWithAdmissionCancellation(type, message, options) {
    const signal = options?.signal;
    if (signal?.aborted) {
      throw new AgentConnectionPromptAdmissionError("Prompt admission was cancelled.", "cancelled");
    }
    if (!signal) {
      await this.requestData(
        {
          type,
          activeSessionId: this.activeSessionId,
          message,
          images: options?.images,
          streamingBehavior: options?.streamingBehavior,
          queueIfBusy: options?.queueIfBusy,
          source: options?.source
        },
        DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS
      );
      return;
    }
    const admissionId = `prompt-admission:${randomUUID2()}`;
    let resolveAbort = () => {
    };
    const aborted = new Promise((resolve3) => {
      resolveAbort = () => resolve3("abort");
    });
    const onAbort = () => resolveAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", onAbort);
      throw new AgentConnectionPromptAdmissionError("Prompt admission was cancelled.", "cancelled");
    }
    const command = {
      type,
      activeSessionId: this.activeSessionId,
      message,
      images: options.images,
      streamingBehavior: options.streamingBehavior,
      queueIfBusy: options.queueIfBusy,
      source: options.source,
      admissionId
    };
    let promptError;
    const promptRequest = this.requestData(command, DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS).catch(
      (error) => {
        promptError = error instanceof DaemonCapabilityUnavailableError && !error.afterReconnect ? new AgentConnectionPromptAdmissionError(error.message, "unsupported", { cause: error }) : error;
        return "failed";
      }
    );
    try {
      const first = await Promise.race([promptRequest.then(() => "settled"), aborted]);
      if (first === "settled" && promptError === void 0) return;
      if (first === "settled" && promptError instanceof AgentConnectionPromptAdmissionError) throw promptError;
      if (first === "settled" && !signal.aborted && promptError instanceof Error && this.definitiveRequestErrors.has(promptError)) {
        throw promptError;
      }
      let status = "unknown";
      try {
        const result = await this.requestData({
          type: "cancel_prompt_admission",
          activeSessionId: this.activeSessionId,
          admissionId,
          ...this.client.supportsServerCapability("owned_prompt_cancellation") ? { cancelOwned: true } : {}
        });
        status = result.status;
      } catch {
      }
      await promptRequest;
      if (promptError instanceof AgentConnectionPromptAdmissionError) throw promptError;
      const definitiveFailure = promptError instanceof Error && this.definitiveRequestErrors.has(promptError);
      if (promptError === void 0 || status === "owned" && type === "prompt" && !definitiveFailure) return;
      throw new AgentConnectionPromptAdmissionError(
        promptError instanceof Error ? promptError.message : "Prompt admission did not complete.",
        status,
        promptError === void 0 ? void 0 : { cause: promptError }
      );
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  async startSideQuestion(id, question, previousTurns) {
    if (previousTurns?.length && !this.client.supportsServerCapability("side_question_transcript")) {
      throw new Error(
        "the daemon is running an older build without side-conversation follow-ups; restart the daemon and try again"
      );
    }
    this.activeSideQuestionIds.add(id);
    try {
      await this.requestOk({
        type: "start_side_question",
        activeSessionId: this.activeSessionId,
        sideQuestionId: id,
        question,
        previousTurns
      });
    } catch (error) {
      this.activeSideQuestionIds.delete(id);
      if (isUnknownDaemonCommandError(error, "start_side_question")) {
        throw new Error("the daemon is running an older build; restart the daemon and try again");
      }
      throw error;
    }
  }
  async abortSideQuestion(id) {
    const data = await this.requestData({
      type: "abort_side_question",
      activeSessionId: this.activeSessionId,
      sideQuestionId: id
    });
    this.activeSideQuestionIds.delete(id);
    return data.aborted;
  }
  async steer(message, images) {
    await this.requestOk({ type: "steer", activeSessionId: this.activeSessionId, message, images });
  }
  async followUp(message, images) {
    await this.requestOk({ type: "follow_up", activeSessionId: this.activeSessionId, message, images });
  }
  async abort() {
    await this.requestOk({ type: "abort", activeSessionId: this.activeSessionId });
  }
  async cancelRlmChild(childId) {
    try {
      const result = await this.requestData({
        type: "cancel_rlm_child",
        activeSessionId: this.activeSessionId,
        childId
      });
      return result.cancelled;
    } catch (error) {
      if (isUnknownDaemonCommandError(error, "cancel_rlm_child")) {
        throw new Error("the daemon is running an older build; restart the daemon and try again");
      }
      throw error;
    }
  }
  async waitForIdle() {
    await this.requestData(
      { type: "wait_for_idle", activeSessionId: this.activeSessionId },
      DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS
    );
  }
  async waitForHeadlessCompletion(options) {
    if (options?.waitForRlmQuiescence && !this.client.supportsServerCapability("rlm_quiescence_barrier")) {
      throw new Error(
        "the daemon is running an older build without RLM quiescence barriers; restart the daemon and try again"
      );
    }
    return this.requestData(
      {
        type: "wait_for_headless_completion",
        activeSessionId: this.activeSessionId,
        ...options?.waitForRlmQuiescence ? { waitForRlmQuiescence: true } : {}
      },
      DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS
    );
  }
  async executeBash(command, options) {
    if (options?.transient && !this.client.supportsServerCapability("transient_bash")) {
      throw new Error(
        "the daemon is running an older build without side-conversation bash; restart the daemon and try again"
      );
    }
    try {
      await this.requestOk({
        type: "execute_bash",
        activeSessionId: this.activeSessionId,
        command,
        excludeFromContext: options?.excludeFromContext,
        transient: options?.transient,
        runId: options?.runId
      });
    } catch (error) {
      if (isUnknownDaemonCommandError(error, "execute_bash")) {
        throw new Error("the daemon is running an older build; restart the daemon and try again");
      }
      throw error;
    }
  }
  async executeBashAndWait(command) {
    return this.requestData(
      {
        type: "execute_bash_and_wait",
        activeSessionId: this.activeSessionId,
        command
      },
      DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS
    );
  }
  async abortBash() {
    try {
      await this.requestOk({ type: "abort_bash", activeSessionId: this.activeSessionId });
    } catch (error) {
      if (isUnknownDaemonCommandError(error, "abort_bash")) {
        throw new Error("the daemon is running an older build; restart the daemon and try again");
      }
      throw error;
    }
  }
  async setModel(provider, modelId) {
    return this.requestData({
      type: "set_model",
      activeSessionId: this.activeSessionId,
      provider,
      modelId
    });
  }
  async cycleModel(direction) {
    const result = await this.requestData({
      type: "cycle_model",
      activeSessionId: this.activeSessionId,
      direction
    });
    return result ?? void 0;
  }
  async setScopedModels(scopedModels) {
    await this.requestOk({
      type: "set_scoped_models",
      activeSessionId: this.activeSessionId,
      scopedModels
    });
  }
  async setThinkingLevel(level) {
    await this.requestOk({ type: "set_thinking_level", activeSessionId: this.activeSessionId, level });
  }
  async setServiceTier(serviceTier) {
    await this.requestOk({ type: "set_service_tier", activeSessionId: this.activeSessionId, serviceTier });
  }
  async cycleThinkingLevel() {
    const result = await this.requestData({
      type: "cycle_thinking_level",
      activeSessionId: this.activeSessionId
    });
    return result?.level;
  }
  async setTransport(transport) {
    await this.requestOk({ type: "set_transport", activeSessionId: this.activeSessionId, transport });
  }
  async setSteeringMode(mode) {
    await this.requestOk({ type: "set_steering_mode", activeSessionId: this.activeSessionId, mode });
  }
  async setFollowUpMode(mode) {
    await this.requestOk({ type: "set_follow_up_mode", activeSessionId: this.activeSessionId, mode });
  }
  async setAutoCompactionEnabled(enabled) {
    await this.requestOk({ type: "set_auto_compaction", activeSessionId: this.activeSessionId, enabled });
  }
  async setAutoRetryEnabled(enabled) {
    await this.requestOk({ type: "set_auto_retry", activeSessionId: this.activeSessionId, enabled });
  }
  async compact(customInstructions) {
    return this.requestData({
      type: "compact",
      activeSessionId: this.activeSessionId,
      customInstructions
    });
  }
  async refine(options = {}) {
    const command = {
      type: "refine",
      activeSessionId: this.activeSessionId,
      instructions: options.instructions,
      rollbackId: options.rollbackId
    };
    if (options.global !== void 0) {
      command.global = options.global;
    }
    return this.requestData(command, DAEMON_REFINE_REQUEST_TIMEOUT_MS);
  }
  async abortCompaction() {
    await this.requestOk({ type: "abort_compaction", activeSessionId: this.activeSessionId });
  }
  async abortBranchSummary() {
    await this.requestOk({ type: "abort_branch_summary", activeSessionId: this.activeSessionId });
  }
  async abortRetry() {
    await this.requestOk({ type: "abort_retry", activeSessionId: this.activeSessionId });
  }
  async reload() {
    await this.requestOk({ type: "reload", activeSessionId: this.activeSessionId });
  }
  async newSession(options) {
    return this.requestData({
      type: "new_session",
      activeSessionId: this.activeSessionId,
      parentSession: options?.parentSession
    });
  }
  async switchSession(sessionPath, options) {
    const sourceActiveSessionId = this.activeSessionId;
    try {
      return await this.requestData({
        type: "switch_session",
        activeSessionId: sourceActiveSessionId,
        sessionPath,
        cwdOverride: options?.cwdOverride
      });
    } catch (error) {
      if (!(error instanceof SessionAlreadyActiveError) || !error.activeSessionId) {
        throw error;
      }
      if (this.options.ownedSession) {
        throw error;
      }
      if (error.activeSessionId === sourceActiveSessionId) {
        return { cancelled: false };
      }
      return this.reattachSession(sourceActiveSessionId, error.activeSessionId);
    }
  }
  async reattachSession(sourceActiveSessionId, targetActiveSessionId) {
    const previousState = {
      lastEventCursor: this.lastEventCursor,
      lastEventSequence: this.lastEventSequence,
      latestSnapshot: this.latestSnapshot,
      latestSnapshotIsFresh: this.latestSnapshotIsFresh,
      retiredEventGenerations: new Set(this.retiredEventGenerations)
    };
    this.activeSessionId = targetActiveSessionId;
    this.lastEventCursor = void 0;
    this.lastEventSequence = void 0;
    this.latestSnapshot = void 0;
    this.latestSnapshotIsFresh = false;
    this.retiredEventGenerations.clear();
    this.pendingReattachActiveSessionIds.add(targetActiveSessionId);
    let reattached = false;
    try {
      const supportsExtensionUi = this.options.supportsExtensionUi !== false;
      const result = await this.requestData({
        type: "reattach",
        activeSessionId: sourceActiveSessionId,
        targetActiveSessionId,
        supportsExtensionUi,
        clientId: this.clientId,
        capabilities: [
          "attach_snapshot",
          "event_sequence",
          ...supportsExtensionUi ? ["extension_ui"] : [],
          "slim_attach",
          "chunked_snapshot",
          ...this.options.ownedSession ? ["client_owned_sessions"] : []
        ],
        env: this.options.sendClientEnv ? collectDaemonClientEnv() : void 0,
        launchEnv: this.options.ownedSession ? collectDaemonLaunchEnv() : void 0,
        telemetryDisabled: this.options.telemetryDisabled
      });
      this.sessionInputPauses.clear();
      this.sessionInputPauseGeneration++;
      reattached = true;
      this.activeSessionId = result.activeSessionId;
      this.activeSideQuestionIds.clear();
      if (result.snapshotStream) {
        try {
          await this.waitForSnapshot(result.snapshotStream.id);
        } catch (snapshotError) {
          await this.snapshotRecoveryPromises.get(result.snapshotStream.id);
          if (!this.latestSnapshotIsFresh) {
            throw snapshotError;
          }
        }
      } else {
        this.applyReplacementSnapshot(result.snapshot, result.replay);
        await this.emit({
          type: "session_replaced",
          state: result.snapshot.state,
          messages: result.snapshot.messages
        });
      }
      return { cancelled: false };
    } catch (error) {
      if (!reattached) {
        this.activeSessionId = sourceActiveSessionId;
        this.lastEventCursor = previousState.lastEventCursor;
        this.lastEventSequence = previousState.lastEventSequence;
        this.latestSnapshot = previousState.latestSnapshot;
        this.latestSnapshotIsFresh = previousState.latestSnapshotIsFresh;
        this.retiredEventGenerations.clear();
        for (const generation of previousState.retiredEventGenerations) {
          this.retiredEventGenerations.add(generation);
        }
      }
      throw error;
    } finally {
      this.pendingReattachActiveSessionIds.delete(targetActiveSessionId);
    }
  }
  async fork(entryId, options) {
    return this.requestData({
      type: "fork",
      activeSessionId: this.activeSessionId,
      entryId,
      position: options?.position
    });
  }
  async navigateTree(targetId, options) {
    return this.requestData({
      type: "navigate_tree",
      activeSessionId: this.activeSessionId,
      targetId,
      summarize: options?.summarize,
      customInstructions: options?.customInstructions,
      replaceInstructions: options?.replaceInstructions,
      label: options?.label
    });
  }
  async importFromJsonl(inputPath, cwdOverride) {
    return this.requestData({
      type: "import_jsonl",
      activeSessionId: this.activeSessionId,
      inputPath,
      cwdOverride
    });
  }
  async exportToHtml(outputPath) {
    const data = await this.requestData({
      type: "export_html",
      activeSessionId: this.activeSessionId,
      outputPath
    });
    return data.path;
  }
  async exportToJsonl(outputPath) {
    const data = await this.requestData({
      type: "export_jsonl",
      activeSessionId: this.activeSessionId,
      outputPath
    });
    return data.path;
  }
  async setSessionName(name) {
    await this.requestOk({ type: "set_session_name", activeSessionId: this.activeSessionId, name });
  }
  async getRlmMaxDepthStatus() {
    return this.requestData({
      type: "get_rlm_max_depth_status",
      activeSessionId: this.activeSessionId
    });
  }
  async setRlmMaxDepth(maxDepth, options) {
    return this.requestData({
      type: "set_rlm_max_depth",
      activeSessionId: this.activeSessionId,
      maxDepth,
      global: options?.global
    });
  }
  async renameSavedSession(sessionPath, name) {
    await renameDaemonSavedSession(this.client, { activeSessionId: this.activeSessionId }, sessionPath, name);
  }
  async deleteSavedSession(sessionPath) {
    return deleteDaemonSavedSession(this.client, { activeSessionId: this.activeSessionId }, sessionPath);
  }
  async watchSession(activeSessionId) {
    let connection;
    try {
      const watchClient = this.client instanceof DaemonRoutedClient ? this.client.controlPlaneTransport : this.client;
      connection = await _DaemonAgentConnection.attach(watchClient, activeSessionId, {
        closeClientOnDispose: false,
        directTransport: false
      });
    } catch {
      return void 0;
    }
    return {
      getMessages: () => connection.getMessages(),
      getCommands: () => connection.getCommands(),
      subscribe: (listener) => connection.subscribe(listener),
      getToolDefinition: (name) => connection.getToolDefinition(name),
      close: () => connection.dispose()
    };
  }
  async dispose() {
    if (this.disposed || this.disposing) {
      return;
    }
    this.disposing = true;
    if (this.options.ownedSession && !this.client.isConnected && this.reconnectPromise) {
      await Promise.race([this.reconnectPromise, delay2(OWNED_SESSION_DISPOSE_RECONNECT_WAIT_MS)]).catch(
        () => void 0
      );
    }
    this.disposed = true;
    this.updateRestartPending = false;
    await Promise.allSettled([...this.activeSideQuestionIds].map((id) => this.abortSideQuestion(id)));
    await this.rosterStore?.dispose().catch(() => void 0);
    this.rosterStore = void 0;
    this.unsubscribeDaemonMessages();
    this.unsubscribeDaemonClose();
    if (this.options.ownedSession) {
      await this.requestOk({ type: "complete_owned_session", activeSessionId: this.activeSessionId }).catch(
        () => void 0
      );
    } else {
      await this.requestOk({ type: "detach", activeSessionId: this.activeSessionId }).catch(() => void 0);
    }
    if (this.options.closeClientOnDispose) {
      this.client.close();
    }
    this.rejectSnapshotAssemblies(new Error("Daemon connection disposed during snapshot transfer"));
  }
  async promoteToResident() {
    await this.withOwnedSessionPromotion(async (promoteOwnedSession) => {
      if (!promoteOwnedSession) return;
      await this.requestOk({ type: "promote_owned_session", activeSessionId: this.activeSessionId });
    });
  }
  withOwnedSessionPromotion(operation) {
    const run = this.ownedSessionPromotionTail.then(async () => {
      const promoteOwnedSession = this.options.ownedSession === true;
      const result = await operation(promoteOwnedSession);
      if (promoteOwnedSession) {
        this.options.ownedSession = false;
      }
      return result;
    });
    this.ownedSessionPromotionTail = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  async reconnect(cause) {
    if (this.reconnectPromise) {
      return this.reconnectPromise;
    }
    this.reconnectPromise = (async () => {
      void this.emit({ type: "connection_status", status: "reconnecting", error: cause.message });
      const timeoutMs = this.options.reconnectTimeoutMs ?? DAEMON_RECONNECT_TIMEOUT_MS;
      let deadline;
      let attempt = 0;
      let lastError = cause;
      while (!this.disposed) {
        const directSessionHeld = this.client instanceof DaemonRoutedClient && this.client.hasDirectTransport;
        if (directSessionHeld) {
          deadline = void 0;
        } else {
          deadline ??= Date.now() + timeoutMs;
          if (Date.now() >= deadline) break;
        }
        let controlPlaneHandshakeComplete = false;
        try {
          await this.options.recoverDaemon?.();
          if (this.disposed) {
            return;
          }
          await this.client.connect(1e3);
          await this.client.waitForHello(3e3);
          controlPlaneHandshakeComplete = true;
          if (directSessionHeld) {
            if (this.rosterStore) await this.rosterStore.attach(this.client).catch(() => void 0);
            if (this.disposed || this.terminalCloseEmitted || this.updateRestartPending) {
              return;
            }
            if (this.client instanceof DaemonRoutedClient && this.client.hasDirectTransport) {
              void this.emit({ type: "connection_status", status: "connected" });
              return;
            }
            continue;
          }
          await this.attach({ recoverable: false });
          if (!this.disposed) {
            const snapshot = await this.getInitialSnapshot({ recoverable: false });
            void this.emit({ type: "session_resynced", snapshot });
            void this.emit({ type: "connection_status", status: "connected" });
          }
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (this.disposed) {
            return;
          }
          const shouldResetControlPlane = !(this.client instanceof DaemonRoutedClient) || !controlPlaneHandshakeComplete || error instanceof DaemonControlPlaneTransportError || !this.client.isControlPlaneReady;
          if (shouldResetControlPlane) this.client.resetTransportForReconnect();
          if (deadline !== void 0 && deadline - Date.now() <= 0) {
            break;
          }
          const delayMs = Math.min(
            ...deadline !== void 0 ? [deadline - Date.now()] : [],
            2e3,
            100 * 2 ** Math.min(attempt, 5)
          );
          attempt++;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
        }
      }
      if (!this.disposed) {
        this.sessionInputPauses.clear();
        this.sessionInputPauseGeneration++;
        this.client.close();
        await this.emit({ type: "closed", error: `Daemon reconnection failed: ${lastError.message}` });
      }
    })().finally(() => {
      this.reconnectPromise = void 0;
    });
    return this.reconnectPromise;
  }
  async requestOk(command) {
    await this.requestData(command);
  }
  async requestData(command, timeoutMs, options) {
    const response = await this.client.request(command, timeoutMs, options);
    if (!response.success) {
      const error = deserializeDaemonError(response);
      this.definitiveRequestErrors.add(error);
      throw error;
    }
    if (invalidatesCachedSnapshot(command.type)) {
      this.latestSnapshotIsFresh = false;
    }
    return response.data;
  }
  async handleDaemonMessage(message) {
    if (message.type === "heartbeats_changed") {
      await this.emit({ type: "heartbeats_changed" });
      return;
    }
    if (!this.isMessageForActiveSession(message)) {
      return;
    }
    if ("snapshotId" in message && this.ignoredSnapshotIds.has(message.snapshotId)) {
      if (message.type === "session_snapshot_end" || message.type === "session_snapshot_failed") {
        this.ignoredSnapshotIds.delete(message.snapshotId);
      }
      return;
    }
    if (message.type === "session_snapshot_begin") {
      const assembly = this.getSnapshotAssembly(message.snapshotId);
      assembly.begin = message;
      return;
    }
    if (message.type === "session_snapshot_chunk") {
      this.getSnapshotAssembly(message.snapshotId).chunks.set(message.index, message.messages);
      return;
    }
    if (message.type === "session_snapshot_end") {
      await this.completeSnapshotAssembly(message);
      return;
    }
    if (message.type === "session_snapshot_failed") {
      const assembly = this.getSnapshotAssembly(message.snapshotId);
      const purpose = assembly.begin?.purpose ?? "attach";
      const snapshotError = new Error(message.error);
      const recoveryPromise = purpose === "replacement" || purpose === "resync" ? this.recoverFailedSnapshot(purpose, snapshotError) : void 0;
      if (recoveryPromise) {
        this.snapshotRecoveryPromises.set(message.snapshotId, recoveryPromise);
      }
      this.rejectSnapshotAssembly(message.snapshotId, assembly, snapshotError);
      this.ignoreSnapshotId(message.snapshotId);
      if (recoveryPromise) {
        try {
          await recoveryPromise;
        } finally {
          this.snapshotRecoveryPromises.delete(message.snapshotId);
        }
      }
      return;
    }
    if (this.isStaleSequencedMessage(message)) {
      return;
    }
    this.observeDaemonEventSequence(message);
    if (message.type === "session_event") {
      if (message.event.type !== "refine_complete" && message.event.type !== "refine_failed") {
        this.observeStreamingMessage(message.event);
      }
      if (message.event.type === "rlm_child_update") {
        this.childRosterSequence = maxEventSequence(this.childRosterSequence, getDaemonMessageSequence(message));
        this.observeRlmChildUpdate(message.event.child);
      }
      this.latestSnapshotIsFresh = false;
      await this.emit({ type: "session_event", event: message.event });
      return;
    }
    if (message.type === "side_question_event") {
      this.observeSideQuestionEvent(message.event);
      await this.emit({ type: "side_question_event", event: message.event });
      return;
    }
    if (message.type === "session_status") {
      if (this.latestSnapshot) {
        this.latestSnapshot = {
          ...this.latestSnapshot,
          state: { ...this.latestSnapshot.state, recap: message.recap }
        };
      }
      await this.emit({ type: "session_status", recap: message.recap });
      return;
    }
    if (message.type === "session_resynced") {
      this.attachedSessionId = message.snapshot.state.sessionId;
      this.attachedSessionFile = message.snapshot.state.sessionFile;
      this.latestSnapshot = mapDaemonSessionSnapshot(message.snapshot);
      if (Array.isArray(message.snapshot.children)) {
        this.childRosterSequence = message.snapshot.lastEventSequence;
      }
      if (this.lastEventSequence !== void 0) {
        this.latestSnapshot.lastEventSequence = this.lastEventSequence;
      }
      if (this.lastEventCursor) {
        this.latestSnapshot.lastEventCursor = this.lastEventCursor;
      }
      this.latestSnapshotIsFresh = true;
      await this.emit({ type: "session_resynced", snapshot: this.latestSnapshot });
      return;
    }
    if (message.type === "session_replaced") {
      this.attachedSessionId = message.state.sessionId;
      this.attachedSessionFile = message.state.sessionFile;
      if (message.snapshotFollows) {
        this.latestSnapshotIsFresh = false;
        return;
      }
      const latestSnapshot = {
        state: message.state,
        messages: message.messages
      };
      if (this.lastEventSequence !== void 0) {
        latestSnapshot.lastEventSequence = this.lastEventSequence;
      }
      if (this.lastEventCursor) {
        latestSnapshot.lastEventCursor = this.lastEventCursor;
      }
      this.latestSnapshot = latestSnapshot;
      this.childRosterSequence = void 0;
      this.latestSnapshotIsFresh = true;
      await this.emit({ type: "session_replaced", state: message.state, messages: message.messages });
      return;
    }
    if (message.type === "extension_ui_request") {
      await this.emit({
        type: "extension_ui_request",
        request: {
          id: message.id,
          method: message.method,
          payload: message.payload
        }
      });
      return;
    }
    if (message.type === "extension_error") {
      await this.emit({
        type: "extension_error",
        extensionPath: message.extensionPath,
        event: message.event,
        error: message.error
      });
      return;
    }
    if (message.type === "session_closed") {
      if (message.reason === "update") {
        this.captureDaemonLogPath();
        this.updateRestartPending = true;
        void this.reconnectAfterUpdate();
        return;
      }
      this.terminalCloseEmitted = true;
      await this.emit({ type: "closed", error: this.formatDaemonSessionClosedError(message.reason) });
    }
  }
  captureDaemonLogPath() {
    const socketPath = this.client.hello?.socketPath;
    if (socketPath) {
      this.daemonLogPath = getDaemonLogPath(socketPath);
    }
  }
  formatDaemonSessionClosedError(reason) {
    const explanation = {
      killed: "The daemon stopped this agent session. Its transcript remains saved and can be reopened from Agents View.",
      shutdown: "The Prime Agent daemon shut down while this window was attached. The session transcript remains saved; restart Prime Agent and reopen it from Agents View.",
      completed: "The daemon closed this agent session after it completed. Its transcript remains available from Agents View.",
      replaced: "The daemon replaced this agent session with another session. Reopen the current session from Agents View.",
      update: "The Prime Agent daemon restarted for an update, but this window did not restore automatically. The session transcript remains saved; restart Prime Agent and reopen it from Agents View."
    };
    return `${explanation[reason]} ${this.formatDaemonDiagnosticContext()}`;
  }
  formatDaemonConnectionClosedError(error) {
    return `Lost connection to the Prime Agent daemon. Cause: ${formatErrorSentence(error)} The session transcript remains saved; restart Prime Agent or reopen the session from Agents View. ${this.formatDaemonDiagnosticContext()}`;
  }
  formatUpdateReconnectError(error) {
    return `The Prime Agent daemon restarted for an update, but this window could not reconnect to its restored session before the recovery timeout expired. Last error: ${formatErrorSentence(error)} The session transcript remains saved; restart Prime Agent and reopen it from Agents View. ${this.formatDaemonDiagnosticContext()}`;
  }
  formatDaemonDiagnosticContext() {
    const details = [];
    if (this.attachedSessionId) {
      details.push(`Session ID: ${this.attachedSessionId}.`);
    }
    if (this.attachedSessionFile) {
      details.push(`Session file: ${this.attachedSessionFile}.`);
    }
    details.push(`Diagnostic log: ${this.daemonLogPath ?? getAgentLogPath()}.`);
    return details.join(" ");
  }
  reconnectAfterUpdate() {
    if (this.updateReconnectPromise) {
      return this.updateReconnectPromise;
    }
    void this.emit({
      type: "connection_status",
      status: "reconnecting",
      error: "The Prime Agent daemon is restarting for an update."
    });
    const reconnectPromise = reconnectDaemonTransportAfterUpdate(this.client).then(() => this.restoreConnectionAfterUpdate()).then(() => {
      if (!this.disposed) {
        void this.emit({ type: "connection_status", status: "connected" });
      }
    }).catch(async (error) => {
      this.updateRestartPending = false;
      this.updateReconnectFailed = true;
      if (!this.disposed) {
        this.terminalCloseEmitted = true;
        await this.emit({
          type: "closed",
          error: this.formatUpdateReconnectError(error)
        });
      }
    }).finally(() => {
      if (this.updateReconnectPromise === reconnectPromise) {
        this.updateReconnectPromise = void 0;
      }
    });
    this.updateReconnectPromise = reconnectPromise;
    return reconnectPromise;
  }
  async restoreConnectionAfterUpdate() {
    const sessionId = this.attachedSessionId;
    const sessionFile = this.attachedSessionFile;
    if (!sessionId && !sessionFile) {
      throw new Error("the previous session identity is unavailable");
    }
    const deadline = Date.now() + UPDATE_RECONNECT_TIMEOUT_MS;
    let lastError;
    while (!this.disposed && Date.now() < deadline) {
      try {
        await this.client.reconnect(1e3);
        if (this.disposed) {
          return;
        }
        const response = await this.client.request({ type: "list" }, 3e4, { recoverable: false });
        if (this.disposed) {
          return;
        }
        if (!response.success) {
          throw deserializeDaemonError(response);
        }
        const sessions = readSessionSummaries(response.data);
        const restored = sessions.find(
          (summary) => summary.activeSessionId !== void 0 && (sessionFile !== void 0 && summary.sessionFile === sessionFile || sessionId !== void 0 && summary.sessionId === sessionId)
        );
        if (restored?.activeSessionId) {
          if (this.disposed) {
            return;
          }
          this.activeSessionId = restored.activeSessionId;
          this.lastEventSequence = void 0;
          this.lastEventCursor = void 0;
          this.retiredEventGenerations.clear();
          await this.attach({ recoverable: false });
          if (this.disposed) {
            return;
          }
          const snapshot = await this.getInitialSnapshot({ recoverable: false });
          if (this.disposed) {
            return;
          }
          this.updateRestartPending = false;
          void this.emit({ type: "session_resynced", snapshot });
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await delay2(UPDATE_RECONNECT_RETRY_MS);
    }
    if (this.disposed) {
      return;
    }
    throw lastError ?? new Error("the restored session did not become available");
  }
  getSnapshotAssembly(snapshotId) {
    const existing = this.snapshotAssemblies.get(snapshotId);
    if (existing) {
      return existing;
    }
    let resolveSnapshot;
    let rejectSnapshot;
    const promise = new Promise((resolve3, reject) => {
      resolveSnapshot = resolve3;
      rejectSnapshot = reject;
    });
    void promise.catch(() => void 0);
    const timeout = setTimeout(() => {
      const current = this.snapshotAssemblies.get(snapshotId);
      if (current) {
        current.reject(new Error(`Timed out waiting for snapshot ${snapshotId}`));
        this.snapshotAssemblies.delete(snapshotId);
        this.ignoreSnapshotId(snapshotId);
      }
    }, this.options.snapshotTimeoutMs ?? DAEMON_SNAPSHOT_TIMEOUT_MS);
    timeout.unref();
    const assembly = {
      chunks: /* @__PURE__ */ new Map(),
      promise,
      resolve: resolveSnapshot,
      reject: rejectSnapshot,
      timeout
    };
    this.snapshotAssemblies.set(snapshotId, assembly);
    return assembly;
  }
  rejectSnapshotAssemblies(error) {
    for (const assembly of this.snapshotAssemblies.values()) {
      clearTimeout(assembly.timeout);
      assembly.reject(error);
    }
    this.snapshotAssemblies.clear();
    this.completedSnapshots.clear();
    this.snapshotRecoveryPromises.clear();
    this.ignoredSnapshotIds.clear();
  }
  ignoreSnapshotId(snapshotId) {
    this.ignoredSnapshotIds.add(snapshotId);
    while (this.ignoredSnapshotIds.size > MAX_IGNORED_SNAPSHOT_IDS) {
      const oldest = this.ignoredSnapshotIds.values().next().value;
      if (oldest === void 0) {
        break;
      }
      this.ignoredSnapshotIds.delete(oldest);
    }
  }
  rejectSnapshotAssembly(snapshotId, assembly, error) {
    assembly.reject(error);
    clearTimeout(assembly.timeout);
    if (assembly.begin?.purpose && assembly.begin.purpose !== "attach") {
      this.snapshotAssemblies.delete(snapshotId);
    }
  }
  async recoverFailedSnapshot(purpose, snapshotError) {
    this.latestSnapshotIsFresh = false;
    if (purpose === "replacement") {
      this.latestSnapshot = void 0;
    }
    try {
      const snapshot = await this.getInitialSnapshot();
      if (this.disposed) {
        return;
      }
      this.attachedSessionId = snapshot.state.sessionId;
      this.attachedSessionFile = snapshot.state.sessionFile;
      if (purpose === "replacement") {
        await this.emit({ type: "session_replaced", state: snapshot.state, messages: snapshot.messages });
      } else {
        await this.emit({ type: "session_resynced", snapshot });
      }
    } catch (recoveryError) {
      if (this.disposed) {
        return;
      }
      this.terminalCloseEmitted = true;
      await this.emit({
        type: "closed",
        error: `Failed to recover from a ${purpose} snapshot transfer. Snapshot error: ${formatErrorSentence(snapshotError)} Recovery error: ${formatErrorSentence(recoveryError)} ${this.formatDaemonDiagnosticContext()}`
      });
    }
  }
  async waitForSnapshot(snapshotId) {
    const completed = this.completedSnapshots.get(snapshotId);
    if (completed) {
      this.completedSnapshots.delete(snapshotId);
      return completed;
    }
    const assembly = this.getSnapshotAssembly(snapshotId);
    try {
      return await assembly.promise;
    } finally {
      clearTimeout(assembly.timeout);
      this.snapshotAssemblies.delete(snapshotId);
      this.completedSnapshots.delete(snapshotId);
    }
  }
  applyReplacementSnapshot(snapshot, replay) {
    if (snapshot.lastEventCursor) {
      this.observeEventCursor(snapshot.lastEventCursor);
    }
    this.lastEventSequence = maxEventSequence(this.lastEventSequence, snapshot.lastEventSequence);
    this.attachedSessionId = snapshot.state.sessionId;
    this.attachedSessionFile = snapshot.state.sessionFile;
    this.latestSnapshot = mapDaemonSessionSnapshot(snapshot, replay);
    this.childRosterSequence = Array.isArray(snapshot.children) ? snapshot.lastEventSequence : void 0;
    this.latestSnapshotIsFresh = true;
  }
  async completeSnapshotAssembly(message) {
    const assembly = this.getSnapshotAssembly(message.snapshotId);
    if (!assembly.begin) {
      this.rejectSnapshotAssembly(
        message.snapshotId,
        assembly,
        new Error(`Snapshot ${message.snapshotId} ended before it began`)
      );
      return;
    }
    if (assembly.chunks.size !== message.chunkCount) {
      this.rejectSnapshotAssembly(
        message.snapshotId,
        assembly,
        new Error(
          `Snapshot ${message.snapshotId} ended with ${assembly.chunks.size} of ${message.chunkCount} chunks`
        )
      );
      return;
    }
    const messages = [];
    for (let index = 0; index < message.chunkCount; index++) {
      const chunk = assembly.chunks.get(index);
      if (!chunk) {
        this.rejectSnapshotAssembly(
          message.snapshotId,
          assembly,
          new Error(`Snapshot ${message.snapshotId} is missing chunk ${index}`)
        );
        return;
      }
      messages.push(...chunk);
    }
    if (messages.length !== assembly.begin.messageCount) {
      this.rejectSnapshotAssembly(
        message.snapshotId,
        assembly,
        new Error(
          `Snapshot ${message.snapshotId} contained ${messages.length} of ${assembly.begin.messageCount} messages`
        )
      );
      return;
    }
    const snapshot = {
      ...assembly.begin.snapshot,
      messages,
      lastEventSequence: message.lastEventSequence,
      lastEventCursor: message.lastEventCursor
    };
    if (message.lastEventCursor) {
      this.observeEventCursor(message.lastEventCursor);
    }
    this.lastEventSequence = maxEventSequence(this.lastEventSequence, message.lastEventSequence);
    this.attachedSessionId = snapshot.state.sessionId;
    this.attachedSessionFile = snapshot.state.sessionFile;
    this.latestSnapshot = mapDaemonSessionSnapshot(snapshot);
    this.latestSnapshotIsFresh = true;
    assembly.resolve(snapshot);
    const purpose = assembly.begin.purpose ?? "attach";
    clearTimeout(assembly.timeout);
    if (purpose !== "attach") {
      this.snapshotAssemblies.delete(message.snapshotId);
      if (this.pendingReattachActiveSessionIds.has(message.activeSessionId)) {
        this.completedSnapshots.set(message.snapshotId, snapshot);
        while (this.completedSnapshots.size > MAX_COMPLETED_SNAPSHOTS) {
          const oldest = this.completedSnapshots.keys().next().value;
          if (oldest === void 0) {
            break;
          }
          this.completedSnapshots.delete(oldest);
        }
      }
    }
    if (purpose === "replacement") {
      await this.emit({ type: "session_replaced", state: snapshot.state, messages });
    } else if (purpose === "resync") {
      await this.emit({ type: "session_resynced", snapshot: this.latestSnapshot });
    }
  }
  observeRlmChildUpdate(child) {
    if (!this.latestSnapshot) return;
    const children = this.latestSnapshot.children ?? [];
    const index = children.findIndex((candidate) => candidate.id === child.id);
    const updatedChildren = [...children];
    if (index === -1) {
      updatedChildren.push(child);
    } else {
      updatedChildren[index] = child;
    }
    this.latestSnapshot = { ...this.latestSnapshot, children: updatedChildren };
  }
  observeStreamingMessage(event) {
    if (!this.latestSnapshot) {
      return;
    }
    if ((event.type === "message_start" || event.type === "message_update") && event.message.role === "assistant") {
      this.latestSnapshot = { ...this.latestSnapshot, streamingMessage: event.message };
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant" || event.type === "agent_end") {
      const { streamingMessage: _streamingMessage, ...snapshot } = this.latestSnapshot;
      this.latestSnapshot = snapshot;
    }
  }
  isMessageForActiveSession(message) {
    if (!("activeSessionId" in message)) {
      return false;
    }
    return message.activeSessionId === this.activeSessionId;
  }
  isStaleSequencedMessage(message) {
    const cursor = getDaemonMessageCursor(message);
    if (cursor) {
      if (this.retiredEventGenerations.has(cursor.generation)) {
        return true;
      }
      return this.lastEventCursor?.generation === cursor.generation && cursor.sequence <= this.lastEventCursor.sequence;
    }
    const sequence = getDaemonMessageSequence(message);
    return sequence !== void 0 && this.lastEventSequence !== void 0 && sequence <= this.lastEventSequence;
  }
  observeDaemonEventSequence(message) {
    const cursor = getDaemonMessageCursor(message);
    if (cursor) {
      this.observeEventCursor(cursor);
      this.lastEventSequence = cursor.sequence;
      return;
    }
    const sequence = getDaemonMessageSequence(message);
    if (sequence === void 0) {
      return;
    }
    this.lastEventSequence = this.lastEventSequence === void 0 ? sequence : Math.max(this.lastEventSequence, sequence);
    if (this.lastEventCursor) {
      this.lastEventCursor = {
        ...this.lastEventCursor,
        sequence: Math.max(this.lastEventCursor.sequence, sequence)
      };
    }
  }
  observeEventCursor(cursor) {
    const current = this.lastEventCursor;
    if (current && current.generation !== cursor.generation) {
      this.retiredEventGenerations.add(current.generation);
    }
    if (!current || current.generation !== cursor.generation || cursor.sequence > current.sequence) {
      this.lastEventCursor = cursor;
    }
  }
  async emit(event) {
    const deliveries = [];
    for (const listener of [...this.listeners]) {
      try {
        deliveries.push(Promise.resolve(listener(event)));
      } catch {
      }
    }
    await Promise.allSettled(deliveries);
  }
  observeSideQuestionEvent(event) {
    if (event.status !== "running") {
      this.activeSideQuestionIds.delete(event.id);
    }
  }
};
function readSessionSummaries(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.sessions)) {
    throw new Error("Daemon returned an invalid session list response");
  }
  return value.sessions;
}
function getAttachActiveSessionId(result) {
  if ("snapshot" in result) {
    return result.activeSessionId;
  }
  return result.activeSessionId ?? result.id;
}
function getAttachLastEventSequence(result) {
  if ("lastEventSequence" in result) {
    return result.lastEventSequence;
  }
  return void 0;
}
function getAttachLastEventCursor(result) {
  if ("lastEventCursor" in result) {
    return result.lastEventCursor;
  }
  return void 0;
}
function maxEventSequence(current, observed) {
  if (current === void 0) {
    return observed;
  }
  if (observed === void 0) {
    return current;
  }
  return Math.max(current, observed);
}
function mapDaemonSessionSnapshot(snapshot, replay) {
  const connectionSnapshot = {
    state: snapshot.state,
    messages: snapshot.messages,
    ...snapshot.summary.streamingMessage ? { streamingMessage: snapshot.summary.streamingMessage } : {},
    lastEventSequence: snapshot.lastEventSequence,
    lastEventCursor: snapshot.lastEventCursor
  };
  if (snapshot.sessionContext) {
    connectionSnapshot.sessionContext = snapshot.sessionContext;
  }
  if (snapshot.sessionTree) {
    connectionSnapshot.sessionTree = snapshot.sessionTree;
  }
  if (snapshot.parent) {
    connectionSnapshot.parent = snapshot.parent;
  }
  if (snapshot.children) {
    connectionSnapshot.children = snapshot.children;
  }
  if (replay) {
    connectionSnapshot.replay = replay;
  }
  return connectionSnapshot;
}
function getDaemonMessageSequence(message) {
  if (!("meta" in message)) {
    return void 0;
  }
  return message.meta?.sequence;
}
function getDaemonMessageCursor(message) {
  if (!("meta" in message)) {
    return void 0;
  }
  return message.meta?.cursor;
}
function invalidatesCachedSnapshot(commandType) {
  switch (commandType) {
    case "attach":
    case "reattach":
    case "detach":
    case "list":
    case "list_saved_sessions":
    case "wait_for_idle":
    case "get_state":
    case "get_connection_state":
    case "get_messages":
    case "get_session_stats":
    case "get_commands":
    case "get_resource_snapshot":
    case "get_queue":
    case "cron_list":
    case "heartbeats_list":
    case "get_session_context":
    case "get_session_tree":
    case "get_user_messages_for_forking":
    case "get_last_assistant_text":
    case "get_system_prompt":
    case "get_tool_definition":
    case "start_side_question":
    case "abort_side_question":
    case "export_html":
    case "export_jsonl":
      return false;
    default:
      return true;
  }
}
export {
  DaemonAgentConnection,
  DaemonClient,
  defaultDaemonSocketPath
};
