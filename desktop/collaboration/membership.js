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
  const policies = [genesis],
    successors = new Map();
  for (const record of records) {
    const p = record.payload;
    if (
      p.kind === "policy" &&
      p.author === owner &&
      p.docId === docId &&
      p.v === 1 &&
      authentic(record)
    ) {
      const key = p.previous + ":" + p.sequence;
      const prior = successors.get(key);
      if (!prior || record.id < prior.id) successors.set(key, record);
    }
  }
  let previous = genesis;
  while (true) {
    const next = successors.get(previous.id + ":" + policies.length);
    if (!next) break;
    const p = next.payload,
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
    children = new Map(),
    proofGrants = new Map();
  for (const record of all.values()) {
    const p = record.payload;
    if (
      p.kind !== "grant" ||
      p.docId !== docId ||
      p.v !== 1 ||
      !validName(p.name) ||
      !validPublicKey(p.subject) ||
      typeof p.parent !== "string" ||
      !authentic(record)
    )
      continue;
    if (!children.has(p.parent)) children.set(p.parent, []);
    children.get(p.parent).push(record);
  }
  const queue = [genesis];
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i];
    const author = parent === genesis ? owner : parent.payload.subject;
    for (const record of children.get(parent.id) || []) {
      const p = record.payload;
      if (
        p.author !== author ||
        (revoked.has(publicId(author)) && !frozenGrants.has(record.id))
      )
        continue;
      grants.set(record.id, record);
      queue.push(record);
      if (p.subject === owner || revoked.has(publicId(p.subject))) continue;
      if (!proofGrants.has(p.subject)) proofGrants.set(p.subject, record);
      const old = accepted.get(p.subject);
      if (!old || record.id < old.id)
        accepted.set(p.subject, {
          id: record.id,
          publicKey: p.subject,
          name: p.name,
          owner: false,
        });
    }
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
    proofGrants,
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
  const candidates = updates
    .filter((record) => {
      const p = record.payload;
      if (equivocal.has(record.id)) return false;
      const grant = state.grants.get(p.grant);
      const authority =
        (p.author === state.owner && p.grant === state.policies[0].id) ||
        grant?.payload.subject === p.author;
      return authority && (state.members.has(p.author) || past.has(record.id));
    })
    .sort((a, b) => b.id.localeCompare(a.id));
  const allowed = new Map(
    dependencyOrder(candidates).map((record) => [record.id, record]),
  );
  return {
    allowed,
    quarantined: updates.filter((r) => !allowed.has(r.id)),
    past,
  };
}

// Ready records are released once, in a stable order for a given journal.
export function dependencyOrder(records, known = new Map()) {
  const waiting = new Map(),
    dependents = new Map(),
    ready = [];
  for (const record of records) {
    const parents = (record.payload.parents || []).filter(
      (id) => !known.has(id),
    );
    if (!parents.length) ready.push(record);
    else waiting.set(record.id, parents.length);
    for (const id of parents) {
      if (!dependents.has(id)) dependents.set(id, []);
      dependents.get(id).push(record);
    }
  }
  for (let i = 0; i < ready.length; i++)
    for (const next of dependents.get(ready[i].id) || []) {
      const remaining = waiting.get(next.id) - 1;
      waiting.set(next.id, remaining);
      if (!remaining) ready.push(next);
    }
  return ready;
}

export const membershipRecords = (state) => [
  ...state.policies.slice(1),
  ...state.grants.values(),
];

export function membershipProof(state, identities) {
  const records = new Map(
    state.policies.slice(1).map((policy) => [policy.id, policy]),
  );
  for (const identity of identities) {
    let grant = state.proofGrants.get(identity);
    while (grant && !records.has(grant.id)) {
      records.set(grant.id, grant);
      grant = state.grants.get(grant.payload.parent);
    }
  }
  return [...records.values()];
}
