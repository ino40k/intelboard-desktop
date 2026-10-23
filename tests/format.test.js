import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRuns, toggleFormat } from '../shared/format.js';
test('plain text and literal markup stay plain; ranges clip and overlap safely', () => {
  assert.deepEqual(formatRuns('a<b>c'), [{ start: 0, end: 5, style: 0 }]);
  assert.deepEqual(
    formatRuns('abcdef', [
      { start: -2, end: 3, style: 1 },
      { start: 2, end: 99, style: 2 },
    ]),
    [
      { start: 0, end: 2, style: 1 },
      { start: 2, end: 3, style: 3 },
      { start: 3, end: 6, style: 2 },
    ],
  );
  assert.deepEqual(formatRuns('', [{ start: 0, end: 10, style: 7 }]), []);
});
test('selection-only styles combine and toggle independently', () => {
  const text = 'plain bold mixed';
  let ranges = toggleFormat(text, [], 6, 16, 1);
  ranges = toggleFormat(text, ranges, 11, 16, 2);
  ranges = toggleFormat(text, ranges, 11, 16, 4);
  assert.deepEqual(ranges, [
    { start: 6, end: 11, style: 1 },
    { start: 11, end: 16, style: 7 },
  ]);
  ranges = toggleFormat(text, ranges, 11, 16, 1);
  assert.deepEqual(ranges, [
    { start: 6, end: 11, style: 1 },
    { start: 11, end: 16, style: 6 },
  ]);
  assert.deepEqual(toggleFormat(text, ranges, 0, 0, 1), ranges);
});
test('mixed selected runs become uniformly marked then unmarked without losing other styles', () => {
  const start = [
    { start: 0, end: 2, style: 1 },
    { start: 2, end: 4, style: 2 },
  ];
  const marked = toggleFormat('abcdef', start, 0, 6, 1);
  assert.deepEqual(marked, [
    { start: 0, end: 2, style: 1 },
    { start: 2, end: 4, style: 3 },
    { start: 4, end: 6, style: 1 },
  ]);
  assert.deepEqual(toggleFormat('abcdef', marked, 0, 6, 1), [{ start: 2, end: 4, style: 2 }]);
});
test('UTF-16 selection positions preserve emoji, newlines and non-Latin text', () => {
  const text = '😀\n日本語';
  const format = toggleFormat(text, [], 3, 6, 4);
  assert.equal(text.slice(format[0].start, format[0].end), '日本語');
  assert.deepEqual(JSON.parse(JSON.stringify(format)), format);
});

import { replaceText } from '../shared/format.js';
import { boardSchema } from '../shared/schema.js';
import { openStore } from '../desktop/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
test('insert, replace, newline and rich paste rebase independent marks', () => {
  const marks = [{ start: 2, end: 4, style: 5 }];
  assert.deepEqual(replaceText('abCDxy', marks, 0, 0, 'new '), {
    text: 'new abCDxy',
    format: [{ start: 6, end: 8, style: 5 }],
  });
  assert.deepEqual(replaceText('abCDxy', marks, 2, 4, 'Q'), {
    text: 'abQxy',
    format: [{ start: 2, end: 3, style: 5 }],
  });
  assert.deepEqual(replaceText('ab', [], 2, 2, '\n'), { text: 'ab\n', format: [] });
  assert.deepEqual(replaceText('ab', [], 1, 1, 'XY', [{ start: 0, end: 2, style: 3 }]), {
    text: 'aXYb',
    format: [{ start: 1, end: 3, style: 3 }],
  });
});
test('formatting survives schema, database reopen and whole-board duplication alongside plain text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'intelboard-format-'));
  let store = openStore(dir);
  try {
    let b = store.create('Inline regression');
    const formats = {
      text: [{ start: 0, end: 3, style: 3 }],
      title: [{ start: 0, end: 3, style: 5 }],
      caption: [{ start: 0, end: 3, style: 4 }],
      description: [{ start: 0, end: 3, style: 2 }],
    };
    b.nodes = [
      {
        id: randomUUID(),
        type: 'research',
        position: { x: 0, y: 0 },
        data: {
          kind: 'note',
          text: 'one plain',
          title: 'one',
          caption: 'one',
          description: 'one',
          formats,
        },
      },
      {
        id: randomUUID(),
        type: 'research',
        position: { x: 400, y: 0 },
        data: { kind: 'note', text: 'legacy <b>plain</b>' },
      },
    ];
    b.edges = [
      {
        id: randomUUID(),
        source: b.nodes[0].id,
        target: b.nodes[1].id,
        sourceHandle: 'top',
        targetHandle: 'bottom',
        type: 'research',
        label: 'one plain',
        data: { directed: false, labelFormat: [{ start: 0, end: 3, style: 7 }] },
      },
    ];
    const validated = boardSchema.parse(b);
    store.save(b.id, validated);
    store.db.close();
    store = openStore(dir);
    const loaded = store.get(b.id);
    assert.deepEqual(loaded.nodes[0].data.formats, formats);
    assert.equal(loaded.nodes[1].data.text, 'legacy <b>plain</b>');
    assert.equal(loaded.nodes[1].data.formats, undefined);
    assert.deepEqual(loaded.edges[0].data, b.edges[0].data);
    const copy = store.duplicate(b.id);
    assert.deepEqual(copy.nodes[0].data.formats, formats);
    assert.deepEqual(copy.edges[0].data, b.edges[0].data);
    assert.notEqual(copy.nodes[0].id, b.nodes[0].id);
    const invalid = structuredClone(validated);
    invalid.nodes[0].data.formats.text[0].style = 8;
    assert.throws(() => boardSchema.parse(invalid));
    invalid.nodes[0].data.formats.text[0] = { start: 3, end: 2, style: 1 };
    assert.throws(() => boardSchema.parse(invalid));
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
