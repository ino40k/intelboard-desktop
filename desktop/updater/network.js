import {
  REPOSITORY,
  MARKER,
  candidates,
  verifyManifest,
  compatible,
  metadataName,
  digest,
  releaseURL,
} from "./manifest.js";
import semver from "semver";

const allowed = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
export function authorizedURL(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    !allowed.has(u.hostname)
  )
    throw Error("Untrusted update address");
  return u;
}
export async function fetchBounded(
  url,
  { limit = 128 * 1024, headers = {}, fetcher = fetch } = {},
) {
  let response;
  for (let redirect = 0; redirect < 6; redirect++) {
    authorizedURL(url);
    response = await fetcher(url, {
      headers: {
        "User-Agent": "IntelBoard-Updater",
        Accept: "application/vnd.github+json",
        ...headers,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location");
      await response.body?.cancel();
      if (!next) throw Error("Invalid update redirect");
      url = new URL(next, url).href;
      continue;
    }
    break;
  }
  if (!response || (response.status >= 300 && response.status !== 304)) {
    await response?.body?.cancel();
    const e = Error(
      response?.status === 403 || response?.status === 429
        ? "GitHub temporarily limited update checks. Try again later."
        : "The update service is unavailable. Try again later.",
    );
    e.status = response?.status;
    throw e;
  }
  if (response.status === 304) return { notModified: true };
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw Error("Update response is too large");
  }
  const parts = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw Error("Update response is too large");
    parts.push(Buffer.from(chunk));
  }
  return { bytes: Buffer.concat(parts), etag: response.headers.get("etag") };
}

export class ReleaseDiscovery {
  constructor({ keys, installed, schema = 2, fetcher = fetch }) {
    Object.assign(this, { keys, installed, schema, fetcher });
    this.cache = new Map();
  }
  async json(url) {
    const old = this.cache.get(url),
      result = await fetchBounded(url, {
        limit: 2 * 1024 * 1024,
        headers: old?.etag ? { "If-None-Match": old.etag } : {},
        fetcher: this.fetcher,
      });
    if (result.notModified) {
      if (!old) throw Error("Invalid update cache");
      return old.value;
    }
    const value = JSON.parse(result.bytes.toString("utf8"));
    this.cache.set(url, { etag: result.etag, value });
    return value;
  }
  async check() {
    const base = `https://api.github.com/repos/${REPOSITORY}/releases`,
      releases = [];
    for (let page = 1; page <= 3; page++) {
      const list = await this.json(`${base}?per_page=100&page=${page}`);
      if (!Array.isArray(list)) throw Error("Invalid update listing");
      releases.push(...list);
      if (list.length < 100) break;
    }
    try {
      const latest = await this.json(`${base}/latest`);
      if (!releases.some((r) => r.id === latest.id)) releases.push(latest);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const result = { stable: null, experimental: null };
    // A signed marker is small and is uploaded last. Never fall back to unsigned
    // checksums or to GitHub's release title as an authenticity mechanism.
    for (const release of candidates(releases, this.installed).slice(0, 12)) {
      if (result.stable && result.experimental) break;
      try {
        const marker = await fetchBounded(
          releaseURL(release.tag_name, MARKER),
          { fetcher: this.fetcher },
        );
        const manifest = verifyManifest(marker.bytes, this.keys, release);
        if (!compatible(manifest, this.schema) || result[manifest.channel])
          continue;
        await this.metadata(manifest);
        result[manifest.channel] = {
          manifest,
          envelope: marker.bytes.toString("utf8"),
          releaseId: release.id,
        };
      } catch (e) {
        if (e.status === 403 || e.status === 429)
          throw e; /* Ignore incomplete, incompatible or untrusted releases. */
      }
    }
    if (
      result.stable &&
      result.experimental &&
      semver.gte(
        result.stable.manifest.version,
        result.experimental.manifest.version,
      )
    )
      result.experimental = null;
    return result;
  }
  async metadata(manifest) {
    for (const platform of ["win32", "linux"]) {
      const name = metadataName(manifest.channel, platform),
        file = manifest.files.find((f) => f.name === name);
      const response = await fetchBounded(releaseURL(manifest.tag, name), {
        fetcher: this.fetcher,
        limit: 64 * 1024,
      });
      if (
        response.bytes.length !== file.size ||
        digest(response.bytes) !== file.sha256
      )
        throw Error("Update metadata verification failed");
    }
  }
  async validate(candidate) {
    const release = await this.json(
      `https://api.github.com/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(candidate.manifest.tag)}`,
    );
    const value = verifyManifest(
      Buffer.from(candidate.envelope),
      this.keys,
      release,
    );
    if (!compatible(value, this.schema))
      throw Error("This update is incompatible with the workspace.");
    await this.metadata(value);
  }
}
