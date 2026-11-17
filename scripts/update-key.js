import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, createHash } from "node:crypto";
const directory = path.resolve(process.argv[2] || ".update-keys");
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = path.join(directory, "update-private.pem");
if (fs.existsSync(file))
  throw Error(
    "A private key already exists here. Keep it; use a new directory only for an intentional key rotation.",
  );
const pair = generateKeyPairSync("ed25519"),
  publicKey = pair.publicKey.export({ format: "pem", type: "spki" }),
  privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" });
const id = createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
fs.writeFileSync(file, privateKey, { mode: 0o600, flag: "wx" });
const trust = "desktop/updater/trusted-keys.json",
  keys = JSON.parse(fs.readFileSync(trust, "utf8"));
keys[id] = publicKey;
fs.writeFileSync(trust, JSON.stringify(keys, null, 2) + "\n");
console.log(
  `Created update signing key ${id}. Only its public key was added to the application. Private key: ${file}`,
);
