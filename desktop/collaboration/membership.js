import { authentic, publicId, validPublicKey } from "./identity.js";

export function validName(name) {
  return (
    typeof name === "string" &&
    name.trim().length > 0 &&
    name.length <= 80 &&
    !/[\x00-\x1f\x7f]/.test(name)
  );
}
export function membership(genesis, records) {
  const uuid = (x) =>
    typeof x === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      x,
    );
  if (
    !authentic(genesis) ||
    genesis.payload.kind !== "genesis" ||
    genesis.payload.v !== 1 ||
    !validName(genesis.payload.name) ||
    !uuid(genesis.payload.docId) ||
    !uuid(genesis.payload.seedSession) ||
    !Array.isArray(genesis.payload.nodes) ||
    genesis.payload.nodes.length > 5000 ||
    genesis.payload.nodes.some((x) => !uuid(x)) ||
    !Array.isArray(genesis.payload.edges) ||
    genesis.payload.edges.length > 10000 ||
    genesis.payload.edges.some((x) => !uuid(x))
  )
    throw new Error("Invalid shared-board ownership proof");
  const owner = genesis.payload.author,
    docId = genesis.payload.docId;
  const all = new Map(records.map((r) => [r.id, r]));
  const policies = [genesis];
  let previous = genesis;
  while (true) {
    const candidates = records
      .filter(
        (r) =>
          r.payload?.kind === "policy" &&
          r.payload.previous === previous.id &&
          r.payload.sequence === policies.length &&
          r.payload.author === owner &&
          r.payload.docId === docId &&
          authentic(r),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!candidates.length) break;
    const next = candidates[0],
      p = next.payload,
      last = previous.payload;
    if (
      !Array.isArray(p.revoked) ||
      p.revoked.length > 256 ||
      p.revoked.some((x) => !/^[a-f0-9]{64}$/.test(x)) ||
      !Array.isArray(p.grants) ||
      p.grants.length > 256 ||
      p.grants.some((x) => !/^[a-f0-9]{64}$/.test(x)) ||
      !Array.isArray(p.heads) ||
      p.heads.length > 256 ||
      p.heads.some((x) => !/^[a-f0-9]{64}$/.test(x)) ||
      (last.revoked || []).some((x) => !p.revoked.includes(x)) ||
      p.revoked.includes(publicId(owner))
    )
      throw new Error("Invalid owner removal policy");
    policies.push(next);
    previous = next;
  }
  const policy = previous;
  const revoked = new Set(policy.payload.revoked || []),
    frozenGrants = new Set(policy.payload.grants || []);
  const accepted = new Map([
    [
      owner,
      {
        id: genesis.id,
        publicKey: owner,
        name: genesis.payload.name || "Owner",
        owner: true,
      },
    ],
  ]);
  const grants = new Map(),
    pending = records.filter((r) => r.payload?.kind === "grant");
  for (let round = 0; round < 257 && pending.length; round++) {
    let progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const r = pending[i],
        p = r.payload;
      if (
        !authentic(r) ||
        p.docId !== docId ||
        p.v !== 1 ||
        !validName(p.name) ||
        !validPublicKey(p.subject)
      ) {
        pending.splice(i, 1);
        continue;
      }
      if (
        typeof p.parent !== "string" ||
        (p.parent !== genesis.id && !grants.has(p.parent))
      )
        continue;
      const parentSubject =
        p.parent === genesis.id ? owner : grants.get(p.parent).payload.subject;
      if (
        p.author !== parentSubject ||
        (revoked.has(publicId(p.author)) && !frozenGrants.has(r.id))
      ) {
        pending.splice(i, 1);
        continue;
      }
      grants.set(r.id, r);
      pending.splice(i, 1);
      progress = true;
      if (!revoked.has(publicId(p.subject))) {
        const old = accepted.get(p.subject);
        if (!old || r.id < old.id)
          accepted.set(p.subject, {
            id: r.id,
            publicKey: p.subject,
            name: p.name,
            owner: false,
          });
      }
    }
    if (!progress) break;
  }
  if (accepted.size > 32)
    throw new Error("This release supports at most 32 collaborators per board");
  return {
    docId,
    owner,
    policy,
    policies,
    members: accepted,
    grants,
    revoked,
    records: all,
  };
}
// Revocation admits only the owner's explicitly observed causal past for a
// removed identity. Previously accepted but unacknowledged forks are retained in
// quarantine and recovery, not inconsistently kept by whichever peer saw them.
export function eligibleUpdates(state, updates) {
  const byId = new Map(updates.map((r) => [r.id, r]));
  const past = new Set(),
    walk = [...(state.policy.payload.heads || [])];
  while (walk.length) {
    const id = walk.pop();
    if (past.has(id)) continue;
    const record = byId.get(id);
    if (!record) continue;
    past.add(id);
    walk.push(...(record.payload.parents || []));
  }
  const writers = new Map(),
    equivocal = new Set();
  for (const r of updates) {
    const key =
      r.payload.author +
      ":" +
      r.payload.session +
      ":" +
      r.payload.writerSequence;
    const previous = writers.get(key);
    if (previous && previous !== r.id) {
      equivocal.add(previous);
      equivocal.add(r.id);
    }
    writers.set(key, r.id);
  }
  const allowed = new Map(),
    remaining = [...updates].sort((a, b) => a.id.localeCompare(b.id));
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = remaining.length - 1; i >= 0; i--) {
      const record = remaining[i],
        p = record.payload;
      if (equivocal.has(record.id)) continue;
      const grant =
        p.grant === state.records.get(p.grant)?.id
          ? state.grants.get(p.grant)
          : null;
      const authority =
        (p.author === state.owner && p.grant === state.policies[0].id) ||
        grant?.payload.subject === p.author;
      if (!authority || (!state.members.has(p.author) && !past.has(record.id)))
        continue;
      if (state.revoked.has(publicId(p.author)) && !past.has(record.id))
        continue;
      if ((p.parents || []).some((id) => !allowed.has(id))) continue;
      allowed.set(record.id, record);
      remaining.splice(i, 1);
      progress = true;
    }
  }
  return { allowed, quarantined: remaining, past };
}
