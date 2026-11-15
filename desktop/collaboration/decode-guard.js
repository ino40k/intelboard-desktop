import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
export class RemoteUpdateGuard {
  constructor() {
    this.waiting = new Map();
    this.checked = new Set();
    this.sequence = 0;
  }
  start() {
    if (this.worker) return;
    const worker = new Worker(new URL("./decode-worker.js", import.meta.url), {
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    });
    worker.unref();
    this.worker = worker;
    worker.on("message", (message) => {
      const task = this.waiting.get(message.id);
      if (!task) return;
      clearTimeout(task.timer);
      this.waiting.delete(message.id);
      if (message.ok) {
        for (const hash of task.hashes) this.checked.add(hash);
        while (this.checked.size > 10000)
          this.checked.delete(this.checked.values().next().value);
        task.resolve();
      } else
        task.reject(new Error("Malformed collaborative update was rejected"));
    });
    const failed = () => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const task of this.waiting.values()) {
        clearTimeout(task.timer);
        task.reject(new Error("Peer update exceeded safe decoding limits"));
      }
      this.waiting.clear();
    };
    worker.on("error", failed);
    worker.on("exit", failed);
  }
  async check(records) {
    if (
      !Array.isArray(records) ||
      records.length > 128 ||
      JSON.stringify(records).length > 4 * 1024 * 1024
    )
      throw new Error("Synchronization message exceeds its limit");
    const updates = [],
      hashes = [];
    for (const record of records)
      if (record.payload?.kind === "update") {
        const data = record.payload.data;
        if (typeof data !== "string" || data.length > 2800000)
          throw new Error("Invalid update encoding");
        const hash = createHash("sha256").update(data).digest("hex");
        if (!this.checked.has(hash)) {
          updates.push(data);
          hashes.push(hash);
        }
      }
    if (!updates.length) return;
    if (this.waiting.size > 32) throw new Error("Peer decoding queue is full");
    this.start();
    const id = ++this.sequence;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("Peer decoding deadline exceeded"));
        const worker = this.worker;
        this.worker = null;
        void worker?.terminate();
        for (const task of this.waiting.values()) {
          clearTimeout(task.timer);
          task.reject(new Error("Peer decoding worker restarted"));
        }
        this.waiting.clear();
      }, 3000);
      timer.unref();
      this.waiting.set(id, { resolve, reject, timer, hashes });
      this.worker.postMessage({ id, updates });
    });
  }
  close() {
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate();
    for (const task of this.waiting.values()) {
      clearTimeout(task.timer);
      task.reject(new Error("Peer networking closed"));
    }
    this.waiting.clear();
  }
}
