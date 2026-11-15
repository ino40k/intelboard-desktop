import { parentPort } from "node:worker_threads";
import * as Y from "yjs";
import { unbase64 } from "../../shared/collaboration/document.js";
parentPort.on("message", ({ id, updates }) => {
  try {
    for (const data of updates) {
      const update = Y.decodeUpdate(unbase64(data));
      if (update.structs.length > 200000 || update.ds.clients.size > 4096)
        throw new Error("Update contains too many operations");
      for (const struct of update.structs)
        if (
          !Number.isSafeInteger(struct.id.client) ||
          struct.id.client < 0 ||
          !Number.isSafeInteger(struct.id.clock) ||
          struct.id.clock < 0 ||
          !Number.isSafeInteger(struct.length) ||
          struct.length < 1 ||
          !Number.isSafeInteger(struct.id.clock + struct.length)
        )
          throw new Error("Invalid operation identifier");
      for (const [, ranges] of update.ds.clients)
        if (
          ranges.length > 200000 ||
          ranges.some(
            (r) =>
              !Number.isSafeInteger(r.clock + r.len) ||
              r.clock < 0 ||
              r.len < 1,
          )
        )
          throw new Error("Invalid delete range");
    }
    parentPort.postMessage({ id, ok: true });
  } catch {
    parentPort.postMessage({ id, ok: false });
  }
});
