// Abrupt-exit fixture. Called only with a generated temporary test profile.
import { createService } from "../desktop/service.js";
import { CollaborationEngine } from "../desktop/collaboration/engine.js";
import { textBinding, boardValue } from "../shared/collaboration/document.js";
const [dir, boardId, phase] = process.argv.slice(2),
  service = createService(dir),
  engine = new CollaborationEngine(service.store);
const edit = () =>
  engine.edit(boardId, (doc) => {
    const node = boardValue(doc).nodes[0];
    textBinding(doc, node.id).insert(0, "durable ");
  });
if (phase === "before")
  service.store.transaction(() => {
    edit();
    process.kill(process.pid, "SIGKILL");
  });
else if (phase === "after") {
  edit();
  process.kill(process.pid, "SIGKILL");
} else throw Error("Invalid synthetic crash phase");
