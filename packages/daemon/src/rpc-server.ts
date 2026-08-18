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
 * Request/response dispatch for the actual tool surface (scene.apply_transaction,
 * editor.enter_play_mode, ...) is M1 work — those methods don't exist until
 * the Unity-side implementation does. This server proves the envelope,
 * the version gate, and the reconnect/idempotency reconciliation, which is
 * the M0 bar (spec §12: "reconnect survives compile, Play Mode entry, and
 * Editor restart").
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

export class RpcServer {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, Session>();
  private handlers = new Map<string, RequestHandler>();
  readonly idempotency: IdempotencyLedger;

  private readonly opts: RpcServerOptions;

  constructor(opts: RpcServerOptions) {
    this.opts = opts;
    this.idempotency = opts.idempotency ?? new IdempotencyLedger();
  }

  registerHandler(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
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
      default:
        // hello_ack / response are server->client only; a client sending
        // one is a protocol violation, but the schema already rejects
        // anything not matching one of the five envelope shapes, so this
        // branch is unreachable in practice — kept only as a defensive default.
        return;
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
