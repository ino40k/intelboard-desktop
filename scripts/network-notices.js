import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
const go = process.env.INTELBOARD_GO || "go",
  options = {
    cwd: "native/network",
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  };
// Include modules actually linked on either supported platform; `-m all` also
// traverses Tailscale's unrelated tool and test dependency graph.
const selected = new Map();
for (const platform of ["linux", "windows"]) {
  const output = execFileSync(go, ["list", "-deps", "-json=Module", "."], {
    ...options,
    env: { ...process.env, GOOS: platform, GOARCH: "amd64", CGO_ENABLED: "0" },
  });
  for (const entry of JSON.parse(
    "[" + output.trim().replace(/}\s*\n{/g, "},{") + "]",
  ))
    if (entry.Module && !entry.Module.Main)
      selected.set(entry.Module.Path, entry.Module);
}
const modules = [...selected.values()].sort((a, b) =>
  a.Path.localeCompare(b.Path),
);
const sections = [],
  inventory = [];
for (const module of modules) {
  if (module.Main) continue;
  let dir = module.Dir;
  if (!dir) {
    const result = JSON.parse(
      execFileSync(
        go,
        ["mod", "download", "-json", module.Path + "@" + module.Version],
        options,
      ),
    );
    dir = result.Dir;
  }
  const names = (await readdir(dir)).filter((n) =>
    /^(license|licence|copying|notice|copyright)([.\-_]|$)/i.test(n),
  );
  if (!names.length)
    throw Error("Missing native module license: " + module.Path);
  let text = module.Path + "@" + module.Version + "\n";
  for (const name of names)
    try {
      text +=
        "\n" + name + "\n" + (await readFile(path.join(dir, name), "utf8"));
    } catch {}
  sections.push(text);
  inventory.push({
    module: module.Path,
    version: module.Version,
    sum: module.Sum,
    licenseFiles: names,
  });
}
const goroot = execFileSync(go, ["env", "GOROOT"], options).trim();
sections.push(
  "Go standard library\n" +
    (await readFile(path.join(goroot, "LICENSE"), "utf8")),
);
await writeFile(
  "licenses/NETWORK_NOTICES.txt",
  "IntelBoard bundled Tailcat transport notices\n\n" +
    sections.join("\n\n" + "=".repeat(72) + "\n\n"),
);
await writeFile(
  "licenses/network-modules.json",
  JSON.stringify(inventory, null, 2) + "\n",
);
console.log(
  "Generated notices and pinned inventory for " +
    inventory.length +
    " Go modules.",
);
