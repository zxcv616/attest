import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { validate } from "@attest/schemas";
import { IdempotencyLedger } from "./idempotency.ts";

/**
 * The daemon is the RPC server; the Unity package is the client that
 * connects and reconnects (spec §6 "The connection model"). Binds loopback
 * only (spec §6 "Deployment": "the daemon binds loopback with an
 * authenticated session"). Domain reload / Play Mode entry / Editor restart
 * all drop the socket as routine, not exceptional — recovery from that is
 * the hello/hello_ack handshake below, not anything socket-level.
 *
 * M1 §Phase 1: the tool surface (scene.apply_transaction, editor.enter_play_mode,
 * ...) is daemon-initiated — the daemon decides a transaction is needed and
 * asks Unity to execute it, not the other way around. That's `callUnity()`
 * below: send a `request` envelope, track it by id, resolve when the
 * matching `response` comes back. `registerHandler`/`handleRequest` above
 * handle the opposite (rare) direction, where Unity calls into the daemon.
 */

export type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

export interface RpcServerOptions {
  port?: number; // 0 = OS-assigned ephemeral port, used by tests
  host?: string; // default 127.0.0.1 — never bind wider than loopback
  supportedUnityVersions: string[];
  supportedPackageSchemaVersions: string[];
  idempotency?: IdempotencyLedger;
}

interface Session {
  token: string;
  ws: WebSocket;
}

interface PendingUnityRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CallUnityOptions {
  /** Required for any mutating method (spec §7). Omit for read-only inspection calls. */
  idempotencyKey?: string;
  /** Whether re-sending this exact call after a dropped connection is safe. Defaults to false (conservative) — spec §6 reconciliation treats "don't know" as "roll back," not "assume fine." */
  retrySafe?: boolean;
  timeoutMs?: number;
}

export class RpcServer {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, Session>();
  private handlers = new Map<string, RequestHandler>();
  private pendingUnityRequests = new Map<string, PendingUnityRequest>();
  private nextRequestId = 0;
  readonly idempotency: IdempotencyLedger;

  private readonly opts: RpcServerOptions;

  constructor(opts: RpcServerOptions) {
    this.opts = opts;
    this.idempotency = opts.idempotency ?? new IdempotencyLedger();
  }

  registerHandler(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  /** Every session currently connected, most-recently-connected last. In practice there's exactly one Unity Editor per daemon (per project), but the daemon doesn't assume that structurally. */
  listSessionTokens(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Sends `method`/`params` to the given Unity session as a `request`
   * envelope and resolves with `result` once the matching `response`
   * arrives (matched by request id — see handleUnityResponse). Rejects on
   * timeout, on a `{ok: false}` response, or if the session isn't connected.
   *
   * If idempotencyKey is set, this wires into the same IdempotencyLedger
   * the reconnect handshake reconciles against (spec §6) — begin() before
   * sending, complete()/fail() on outcome — so a domain reload mid-call is
   * something the NEXT hello can actually reason about, not just something
   * this one call fails into the void on.
   */
  async callUnity(sessionToken: string, method: string, params?: unknown, opts: CallUnityOptions = {}): Promise<unknown> {
    const session = this.sessions.get(sessionToken);
    if (!session) {
      throw new Error(`No active session: ${sessionToken}`);
    }

    const id = `req_${++this.nextRequestId}_${Date.now()}`;
    const timeoutMs = opts.timeoutMs ?? 30_000;

    if (opts.idempotencyKey) {
      this.idempotency.begin(opts.idempotencyKey, { retrySafe: opts.retrySafe ?? false });
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUnityRequests.delete(id);
        const err = new Error(`Timed out after ${timeoutMs}ms waiting for Unity response to ${method} (id=${id})`);
        if (opts.idempotencyKey) this.idempotency.fail(opts.idempotencyKey);
        reject(err);
      }, timeoutMs);

      this.pendingUnityRequests.set(id, {
        resolve: (result) => {
          if (opts.idempotencyKey) this.idempotency.complete(opts.idempotencyKey, result);
          resolve(result);
        },
        reject: (err) => {
          if (opts.idempotencyKey) this.idempotency.fail(opts.idempotencyKey);
          reject(err);
        },
        timer,
      });

      this.send(session.ws, {
        type: "request",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
    });
  }

  async listen(): Promise<{ port: number }> {
    const host = this.opts.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new Error(`Refusing to bind outside loopback (spec §6 local-first default): ${host}`);
    }
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.opts.port ?? 0, host }, () => {
        const address = this.wss!.address();
        if (typeof address === "string" || !address) {
          reject(new Error("Unexpected server address"));
          return;
        }
        resolve({ port: address.port });
      });
      this.wss.on("connection", (ws) => this.handleConnection(ws));
      this.wss.on("error", reject);
    });
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.ws.close();
    this.sessions.clear();
    await new Promise<void>((resolve, reject) => {
      if (!this.wss) return resolve();
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private handleConnection(ws: WebSocket): void {
    ws.on("message", (raw) => {
      void this.handleMessage(ws, raw.toString());
    });
  }

  private send(ws: WebSocket, message: unknown): void {
    ws.send(JSON.stringify(message));
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send(ws, { type: "response", requestId: "unknown", ok: false, error: { code: "bad_json", message: "not valid JSON", retryable: false } });
      return;
    }

    const { valid, errors } = validate("rpc", msg);
    if (!valid) {
      this.send(ws, { type: "response", requestId: "unknown", ok: false, error: { code: "invalid_envelope", message: errors.join("; "), retryable: false } });
      return;
    }

    const envelope = msg as { type: string };
    switch (envelope.type) {
      case "hello":
        this.handleHello(ws, msg as HelloMessage);
        return;
      case "request":
        await this.handleRequest(ws, msg as RequestMessage);
        return;
      case "heartbeat":
        this.handleHeartbeat(msg as HeartbeatMessage);
        return;
      case "response":
        // Unity answering a callUnity() request (M1 §Phase 1). Previously
        // fell through to the default no-op branch below and was silently
        // dropped — every callUnity() call would have hung until timeout
        // regardless of what Unity actually returned.
        this.handleUnityResponse(msg as ResponseMessage);
        return;
      default:
        // hello_ack is server->client only; a client sending one is a
        // protocol violation, but the schema already rejects anything not
        // matching one of the five envelope shapes, so this is unreachable
        // in practice — kept only as a defensive default.
        return;
    }
  }

  private handleUnityResponse(res: ResponseMessage): void {
    const pending = this.pendingUnityRequests.get(res.requestId);
    if (!pending) return; // already timed out, or a stray/duplicate — nothing to resolve
    clearTimeout(pending.timer);
    this.pendingUnityRequests.delete(res.requestId);
    if (res.ok) {
      pending.resolve(res.result);
    } else {
      pending.reject(new Error(res.error?.message ?? `Unity request ${res.requestId} failed`));
    }
  }

  private handleHello(ws: WebSocket, hello: HelloMessage): void {
    const compatible =
      this.opts.supportedUnityVersions.includes(hello.unityVersion) &&
      this.opts.supportedPackageSchemaVersions.includes(hello.packageSchemaVersion);

    if (!compatible) {
      this.send(ws, { type: "hello_ack", sessionToken: "", compatible: false });
      ws.close();
      return;
    }

    const token = hello.sessionToken && this.sessions.has(hello.sessionToken) ? hello.sessionToken : randomBytes(16).toString("hex");
    this.sessions.set(token, { token, ws });

    const action = this.idempotency.reconcile(hello.lastIdempotencyKey ?? null);

    this.send(ws, {
      type: "hello_ack",
      sessionToken: token,
      compatible: true,
      ...(action ? { pendingReconciliation: { idempotencyKey: hello.lastIdempotencyKey, action } } : {}),
    });
  }

  private async handleRequest(ws: WebSocket, req: RequestMessage): Promise<void> {
    const handler = this.handlers.get(req.method);
    if (!handler) {
      this.send(ws, {
        type: "response",
        requestId: req.id,
        ok: false,
        error: { code: "unknown_method", message: `No handler registered for ${req.method} (M1+ tool surface not yet implemented)`, retryable: false },
      });
      return;
    }
    try {
      const result = await handler(req.params);
      this.send(ws, { type: "response", requestId: req.id, ok: true, result });
    } catch (err) {
      this.send(ws, {
        type: "response",
        requestId: req.id,
        ok: false,
        error: { code: "handler_error", message: err instanceof Error ? err.message : String(err), retryable: false },
      });
    }
  }

  private heartbeatListeners: ((hb: HeartbeatMessage) => void)[] = [];
  onHeartbeat(fn: (hb: HeartbeatMessage) => void): void {
    this.heartbeatListeners.push(fn);
  }
  private handleHeartbeat(hb: HeartbeatMessage): void {
    for (const fn of this.heartbeatListeners) fn(hb);
  }
}

interface HelloMessage {
  type: "hello";
  unityVersion: string;
  packageSchemaVersion: string;
  projectPath?: string;
  sessionToken?: string | null;
  lastIdempotencyKey?: string | null;
  reason?: string;
}
interface RequestMessage {
  type: "request";
  id: string;
  method: string;
  params?: unknown;
  idempotencyKey?: string;
}
interface HeartbeatMessage {
  type: "heartbeat";
  at: string;
  editorState?: string;
}
interface ResponseMessage {
  type: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
}
