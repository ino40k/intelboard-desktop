import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { videoMime, youtubeVideo, youtubeEmbedUrl } from '../shared/media.js';
import { videoMimeFromBytes } from '../desktop/video.js';
const fixture = (name) => readFile(new URL('./fixtures/' + name, import.meta.url));
const videoId = 'M7lc1UVf-VE';
test('YouTube watch, short, shorts, mobile, live and embed links normalize safely with timestamps', () => {
  const urls = [
    `https://youtube.com/watch?v=${videoId}&list=unrelated`,
    `https://www.youtube.com/watch?v=${videoId}`,
    `https://m.youtube.com/watch?v=${videoId}`,
    `https://youtu.be/${videoId}?si=share-token`,
    `https://www.youtube.com/shorts/${videoId}`,
    `https://youtube.com/embed/${videoId}`,
    `https://youtube.com/live/${videoId}`,
    `https://www.youtube-nocookie.com/embed/${videoId}`,
  ];
  for (const url of urls) {
    assert.equal(youtubeVideo(url).id, videoId);
    assert.equal(new URL(youtubeEmbedUrl(url)).hostname, 'www.youtube-nocookie.com');
    assert.equal(new URL(youtubeEmbedUrl(url)).searchParams.get('controls'), '1');
  }
  assert.equal(youtubeVideo(urls[1] + '&t=1h2m3s').start, 3723);
  assert.equal(youtubeVideo(`https://youtu.be/${videoId}?t=42`).start, 42);
  assert.equal(youtubeVideo(`https://youtube.com/shorts/${videoId}#t=1m`).start, 60);
  assert.equal(
    new URL(youtubeEmbedUrl(`https://youtu.be/${videoId}?start=90`)).searchParams.get('start'),
    '90',
  );
  for (const url of [
    'https://youtube.com/playlist?list=abc',
    'https://youtube.com/@channel',
    'https://youtube.com/watch?v=bad',
    `https://youtube.com.evil.example/watch?v=${videoId}`,
    `https://youtube.com@evil.example/watch?v=${videoId}`,
    `https://evil.example/?url=https://youtu.be/${videoId}`,
    `javascript://youtube.com/watch?v=${videoId}`,
    `https://youtube.com:8080/watch?v=${videoId}`,
  ])
    assert.equal(youtubeEmbedUrl(url), null, url);
});
