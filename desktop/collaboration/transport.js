import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

export class TailcatTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.pending = new Map();
    this.queues = new Map();
    this.queueLengths = new Map();
    this.buffer = "";
    this.stopped = false;
  }
  start(config = {}) {
    if (this.child) return;
    const executable =
      this.options.executable ||
      path.join(
        this.options.resources ||
          path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
        "native",
        "bin",
        "intelboard-network" + (process.platform === "win32" ? ".exe" : ""),
      );
    this.child = spawn(executable, [], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        SSL_CERT_FILE: process.env.SSL_CERT_FILE,
        SSL_CERT_DIR: process.env.SSL_CERT_DIR,
      },
    });
    const decoder = new StringDecoder("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += decoder.write(chunk);
      if (Buffer.byteLength(this.buffer) > 9 * 1024 * 1024) {
        this.child.kill();
        return;
      }
      let end;
      while ((end = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.event === "reply") {
            const request = this.pending.get(event.request);
            if (request) {
              this.pending.delete(event.request);
              clearTimeout(request.timer);
              event.error
                ? request.reject(new Error(event.error))
                : request.resolve(event.result);
            }
          } else this.emit(event.event, event);
        } catch {
          this.child.kill();
        }
      }
    });
    let exited = false;
    const failed = () => {
      if (exited) return;
      exited = true;
      this.child = null;
      this.buffer = "";
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(
          new Error(
            "Peer networking stopped. Local editing remains available.",
          ),
        );
      }
      this.pending.clear();
      this.emit("unavailable", {
        message:
          "Peer networking is unavailable; local changes are saved on this device.",
      });
      if (!this.stopped) {
        this.retry = setTimeout(
          () => this.start(this.options.getConfig?.() || config),
          15000,
        );
        this.retry.unref();
      }
    };
    this.child.on("error", failed);
    this.child.on("exit", failed);
    void this.request("start", { config }).catch(() => {});
  }
  request(op, body = {}) {
    if (!this.child?.stdin.writable)
      return Promise.reject(new Error("Peer networking is not running"));
    if (this.pending.size >= 128)
      return Promise.reject(
        new Error("Peer network queue is full; retry shortly"),
      );
    return new Promise((resolve, reject) => {
      const request = randomUUID(),
        timer = setTimeout(() => {
          this.pending.delete(request);
          reject(
            new Error(
              "Peer connection timed out; retry when a collaborator is online.",
            ),
          );
        }, 18000);
      timer.unref();
      this.pending.set(request, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ op, request, ...body }) + "\n",
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(request);
            reject(error);
          }
        },
      );
    });
  }
  async dial(address, lane = "control") {
    const event = await this.request("dial", { address, lane });
    this.emit("connected", event);
    return event;
  }
  send(id, frame) {
    const length = this.queueLengths.get(id) || 0;
    if (frame.type === "presence" && length > 2) return Promise.resolve();
    if (length >= 128)
      return Promise.reject(
        new Error(
          "Peer transfer queue is full; history will catch up on retry.",
        ),
      );
    this.queueLengths.set(id, length + 1);
    const previous = this.queues.get(id) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.request("send", { id, frame }));
    this.queues.set(id, next);
    next
      .finally(() => {
        if (this.queues.get(id) === next) this.queues.delete(id);
        const remaining = (this.queueLengths.get(id) || 1) - 1;
        if (remaining) this.queueLengths.set(id, remaining);
        else this.queueLengths.delete(id);
      })
      .catch(() => {});
    return next;
  }
  disconnect(id) {
    return this.request("close", { id }).catch(() => {});
  }
  close() {
    this.stopped = true;
    clearTimeout(this.retry);
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    const kill = setTimeout(() => child.kill("SIGKILL"), 1500);
    kill.unref();
    child.once("exit", () => clearTimeout(kill));
  }
}
