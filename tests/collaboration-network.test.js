import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { createService } from "../desktop/service.js";
import { CollaborationManager } from "../desktop/collaboration/manager.js";
import { collaborationId } from "../shared/collaboration/ids.js";
import { boardValue, patchBoard } from "../shared/collaboration/document.js";

test(
  "real Tailcat: invitations, member invitation without owner, resumable media, offline forks and three-peer convergence",
  { skip: !process.env.INTELBOARD_TEST_TAILCAT, timeout: 100000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "intelboard-real-peers-"),
    );
    const peers = ["a", "b", "c"].map((n) => {
      const dir = path.join(root, n),
        service = createService(dir);
      return {
        dir,
        service,
        manager: new CollaborationManager(service, dir, {
          executable: process.env.INTELBOARD_TEST_NETWORK_BINARY,
        }),
      };
    });
    t.after(async () => {
      for (const p of peers) p.manager.close();
      await new Promise((r) => setTimeout(r, 1700));
      for (const p of peers) p.service.close();
      await rm(root, { recursive: true, force: true });
    });
    const until = async (fn, label) => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("Timed out: " + label);
    };
    const [a, b, c] = peers,
      original = randomBytes(192 * 1024),
      asset = await a.service.assets.add(
        original,
        "synthetic.bin",
        "application/octet-stream",
      );
    const board = a.service.store.create("Synthetic real peers");
    board.nodes = [
      {
        id: randomUUID(),
        type: "research",
        position: { x: 0, y: 0 },
        style: { width: 280, height: 220 },
        data: { kind: "note", text: "Shared text" },
      },
      {
        id: randomUUID(),
        type: "research",
        position: { x: 400, y: 0 },
        style: { width: 280, height: 220 },
        data: {
          kind: "file",
          assetId: asset.id,
          filename: asset.filename,
          mime: asset.mime,
          size: asset.size,
        },
      },
    ];
    a.service.store.save(board.id, board);
    a.id = board.id;
    await a.manager.handle("share", a.id);
    const invitation = await a.manager.invite(a.id);
    b.id = (await b.manager.join(invitation.code)).boardId;
    await until(
      () => b.service.store.get(b.id).nodes.length === 2,
      "initial structural transfer",
    );
    const manifest = [
      ...a.manager.engine.get(a.id).doc.getMap("assets").values(),
    ][0];
    await until(
      () =>
        b.manager.media.complete(manifest, b.manager.engine.get(b.id).docId),
      "attachment transfer",
    );
    assert.deepEqual(
      await readFile(path.join(b.service.assets.folder, manifest.id)),
      original,
    );
    a.manager.transport.close();
    a.manager.transport = null;
    a.manager.address = null;
    const memberInvitation = await b.manager.invite(b.id);
    c.id = (await c.manager.join(memberInvitation.code)).boardId;
    await until(
      () => c.service.store.get(c.id).nodes.length === 2,
      "member-to-newcomer transfer without owner",
    );
    const edit = (peer, text) =>
      peer.manager.engine.edit(peer.id, (doc) => {
        const before = boardValue(doc),
          after = structuredClone(before);
        after.nodes.find((n) => n.data.kind === "note").data.text += text;
        const nonce = randomUUID(),
          session = peer.manager.engine.get(peer.id).session;
        after.nodes.push({
          id: collaborationId(peer.manager.engine.identity.id, nonce, session),
          type: "research",
          position: { x: 800, y: 500 },
          style: { width: 280, height: 220 },
          data: { kind: "note", text },
        });
        patchBoard(doc, before, after, {
          actor: peer.manager.engine.identity.id,
          session,
          nonceForId: () => nonce,
          batch: "offline-" + text,
        });
      });
    for (const p of [b, c]) {
      p.manager.transport.close();
      p.manager.transport = null;
      p.manager.address = null;
    }
    await new Promise((r) => setTimeout(r, 1800));
    edit(b, " B");
    edit(c, " C");
    b.manager.startNetwork();
    c.manager.startNetwork();
    await Promise.all([b.manager.ready(), c.manager.ready()]);
    const value = (p) =>
      JSON.stringify(boardValue(p.manager.engine.get(p.id).doc));
    await until(
      () =>
        value(b) === value(c) && b.service.store.get(b.id).nodes.length === 4,
      "offline fork convergence",
    );
    a.manager.startNetwork();
    await a.manager.ready();
    await until(() => value(a) === value(b), "three-peer catch-up");
    assert.ok(
      a.manager.engine
        .get(a.id)
        .members.members.has(c.manager.engine.identity.publicKey),
    );
    const text = a.service.store
      .get(a.id)
      .nodes.find((n) => n.id === board.nodes[0].id).data.text;
    assert.ok(text.includes(" B") && text.includes(" C"));
    const revoked = await b.manager.invite(b.id);
    await b.manager.handle("cancel-invite", b.id, { id: revoked.id });
    await assert.rejects(c.manager.join(revoked.code), /expired|revoked|used/);
    const expired = await b.manager.invite(b.id);
    b.service.store.db
      .prepare("UPDATE collab_invites SET expires=? WHERE id=?")
      .run(Date.now() - 1, expired.id);
    await assert.rejects(c.manager.join(expired.code), /expired|revoked|used/);
    b.manager.transport.child.kill("SIGKILL");
    await until(() => !b.manager.address, "helper crash detected");
    edit(b, " after crash");
    await until(() => !!b.manager.address, "automatic helper restart");
    await until(
      () => value(a) === value(b) && value(b) === value(c),
      "catch-up after helper process crash",
    );
    a.manager.engine.revoke(a.id, b.manager.engine.identity.id);
    await until(
      () =>
        b.manager.engine.status(b.id).active === false &&
        !c.manager.engine
          .get(c.id)
          .members.members.has(b.manager.engine.identity.publicKey),
      "owner removal propagation",
    );
    assert.throws(() => edit(b, " forbidden"), /permission/);
    await assert.rejects(b.manager.invite(b.id), /Only current collaborators/);
    c.manager.transport.close();
    c.manager.transport = null;
    c.manager.address = null;
    await new Promise((resolve) => setTimeout(resolve, 1800));
    a.manager.engine.revoke(a.id, c.manager.engine.identity.id);
    c.manager.startNetwork();
    await c.manager.ready();
    await until(
      () => c.manager.engine.status(c.id).active === false,
      "offline removed peer learns signed removal on reconnect",
    );
    t.diagnostic(
      "Real encrypted Tailcat transport, forwarding, offline merge and media integrity verified with three temporary profiles.",
    );
  },
);
