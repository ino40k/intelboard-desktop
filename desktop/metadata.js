import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import { load } from 'cheerio';
export function isPublicAddress(value) {
  try {
    let ip = ipaddr.parse(value);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    return ip.range() === 'unicast';
  } catch {
    return false;
  }
}
export async function resolvePublic(raw, lookup = dns.lookup) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only public HTTP and HTTPS links are supported');
  if (url.port && !['80', '443'].includes(url.port))
    throw new Error('Nonstandard ports are blocked');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = ipaddr.isValid(hostname)
    ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((x) => !isPublicAddress(x.address)))
    throw new Error('Private or reserved network destinations are blocked');
  return { url, address: addresses[0] };
}
export async function fetchPublic(
  raw,
  { maxBytes = 2 * 1024 * 1024, redirects = 4, timeout = 8000 } = {},
) {
  const deadline = Date.now() + timeout;
  async function follow(target, left) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Source request timed out');
    let timer;
    const resolved = await Promise.race([
      resolvePublic(target),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Source lookup timed out')), remaining);
      }),
    ]).finally(() => clearTimeout(timer));
    const { url, address } = resolved;
    const result = await new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.get(
        url,
        {
          headers: {
            'User-Agent': 'Intelboard/1.0 (private research bookmark capture)',
            Accept: 'text/html,image/*;q=0.8,*/*;q=0.5',
            'Accept-Encoding': 'identity',
          },
          lookup: (_host, options, callback) =>
            options.all
              ? callback(null, [address])
              : callback(null, address.address, address.family),
        },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume();
            return resolve({ redirect: res.headers.location });
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return reject(new Error('Source returned HTTP ' + res.statusCode));
          }
          if (Number(res.headers['content-length']) > maxBytes) {
            res.destroy();
            return reject(new Error('Source exceeds capture size limit'));
          }
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              res.destroy(new Error('Source exceeds capture size limit'));
            } else chunks.push(chunk);
          });
          res.on('end', () =>
            resolve({
              buffer: Buffer.concat(chunks),
              type: res.headers['content-type'] || '',
              url: url.href,
            }),
          );
          res.on('error', reject);
        },
      );
      const endTimer = setTimeout(
        () => req.destroy(new Error('Source request timed out')),
        Math.max(1, deadline - Date.now()),
      );
      req.on('close', () => clearTimeout(endTimer));
      req.on('error', reject);
    });
    if ('redirect' in result) {
      if (!left || !result.redirect) throw new Error('Too many or invalid redirects');
      return follow(new URL(result.redirect, url).href, left - 1);
    }
    return result;
  }
  return follow(raw, redirects);
}
const clean = (value) => (value || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
export function parseMetadata(html, url) {
  const $ = load(html),
    meta = (...keys) => {
      for (const key of keys) {
        const value = $(`meta[property="${key}"],meta[name="${key}"]`).first().attr('content');
        if (value) return clean(value);
      }
      return '';
    };
  const absolute = (value) => {
    try {
      const u = new URL(value, url);
      return /^https?:$/.test(u.protocol) ? u.href : '';
    } catch {
      return '';
    }
  };
  const image = meta('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src');
  return {
    url,
    title:
      meta('og:title', 'twitter:title') ||
      clean($('title').first().text()) ||
      new URL(url).hostname,
    description: meta('og:description', 'twitter:description', 'description'),
    siteName: meta('og:site_name'),
    domain: new URL(url).hostname,
    author: meta('author', 'article:author'),
    publishedAt: meta('article:published_time', 'date', 'datePublished'),
    imageUrl: image ? absolute(image) : '',
    faviconUrl: absolute($('link[rel~="icon"]').first().attr('href') || '/favicon.ico'),
    capturedAt: new Date().toISOString(),
  };
}
