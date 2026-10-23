import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { loopingGif } from '../desktop/gif.js';

test('looping GIF variant preserves original bytes, pixels and timing while overriding finite loops', async () => {
  const original = await sharp(Buffer.from([255,0,0,255,0,255,0,255]), {raw:{width:1,height:2,channels:4,pageHeight:1}}).gif({loop:2,delay:[100,200]}).toBuffer();
  const before = Buffer.from(original);
  const result = loopingGif(original);
  const source = await sharp(original, { animated: true }).metadata();
  const variant = await sharp(result, { animated: true }).metadata();
  assert.equal(source.loop, 2);
  assert.equal(variant.loop, 0);
  assert.equal(variant.pages, 2);
  assert.deepEqual(variant.delay, source.delay);
  assert.deepEqual(original, before);
  assert.deepEqual(await sharp(result, { animated: true }).raw().toBuffer(), await sharp(original, { animated: true }).raw().toBuffer());
  assert.equal(result.toString('ascii').split('NETSCAPE2.0').length, 2);
  assert.deepEqual(loopingGif(result), result);

});
test('malformed or non-GIF input fails safely', () => {
  for (const bytes of [Buffer.from('<svg/>'),Buffer.from('GIF89a'),Buffer.from('GIF89a'+String.fromCharCode(0).repeat(20))])
    assert.throws(() => loopingGif(bytes));
});
