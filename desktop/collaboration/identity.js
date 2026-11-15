import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  sign,
  verify,
  randomUUID,
  randomBytes,
} from "node:crypto";
export { randomUUID, randomBytes };
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
      .join(",") +
    "}"
  );
}
export const hash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : canonical(value),
    )
    .digest("hex");
export const publicId = (publicKey) => hash(Buffer.from(publicKey, "base64"));
export function validPublicKey(value) {
  try {
    const bytes = Buffer.from(value, "base64");
    return (
      typeof value === "string" &&
      bytes.length === 44 &&
      bytes.toString("base64") === value &&
      createPublicKey({ key: bytes, type: "spki", format: "der" })
        .asymmetricKeyType === "ed25519"
    );
  } catch {
    return false;
  }
}
export function newIdentity(name = "Collaborator") {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  return {
    id: publicId(publicKey),
    publicKey,
    privateKey: pair.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64"),
    name,
  };
}
export function signed(identity, payload) {
  const body = JSON.parse(
    JSON.stringify({ ...payload, author: identity.publicKey }),
  );
  const bytes = Buffer.from(canonical(body));
  return {
    id: hash(bytes),
    payload: body,
    signature: sign(
      null,
      bytes,
      createPrivateKey({
        key: Buffer.from(identity.privateKey, "base64"),
        type: "pkcs8",
        format: "der",
      }),
    ).toString("base64"),
  };
}
export function authentic(record) {
  try {
    if (
      !record ||
      !/^[a-f0-9]{64}$/.test(record.id) ||
      typeof record.signature !== "string" ||
      record.signature.length !== 88 ||
      typeof record.payload?.author !== "string" ||
      record.payload.author.length > 100
    )
      return false;
    const bytes = Buffer.from(canonical(record.payload));
    const key = createPublicKey({
      key: Buffer.from(record.payload.author, "base64"),
      type: "spki",
      format: "der",
    });
    return (
      key.asymmetricKeyType === "ed25519" &&
      hash(bytes) === record.id &&
      verify(null, bytes, key, Buffer.from(record.signature, "base64"))
    );
  } catch {
    return false;
  }
}
