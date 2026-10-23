import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from 'react';
import { Bold, Italic, Underline } from 'lucide-react';
import { formatRuns, toggleFormat, replaceText, type FormatRange } from '../shared/format.js';
export type { FormatRange } from '../shared/format.js';
const styleFor = (mask: number) => ({
  fontWeight: mask & 1 ? 700 : undefined,
  fontStyle: mask & 2 ? 'italic' : undefined,
  textDecoration: mask & 4 ? 'underline' : undefined,
});
export function InlineText({ text = '', format = [] }: { text?: string; format?: FormatRange[] }) {
  return (
    <>
      {formatRuns(text, format).map((r) => (
        <span key={r.start} style={styleFor(r.style)}>
          {text.slice(r.start, r.end)}
        </span>
      ))}
    </>
  );
}
type Value = { text: string; format: FormatRange[] };
type Selection = { start: number; end: number };
type Snapshot = Value & { selection: Selection };
function selectionIn(root: HTMLElement): Selection | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  return {
    start: prefix.toString().length,
    end: prefix.toString().length + range.toString().length,
  };
}
function restoreSelection(root: HTMLElement, selection: Selection) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
    texts: Text[] = [];
  let current: Node | null;
  while ((current = walker.nextNode())) texts.push(current as Text);
  if (!texts.length) {
    root.append(document.createTextNode(''));
    texts.push(root.firstChild as Text);
  }
  const locate = (offset: number): [Node, number] => {
    for (const text of texts) {
      if (offset <= text.length) return [text, offset];
      offset -= text.length;
    }
    const last = texts[texts.length - 1];
    return [last, last.length];
  };
  const range = document.createRange();
  range.setStart(...locate(selection.start));
  range.setEnd(...locate(selection.end));
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}
function paint(root: HTMLElement, value: Value) {
  const fragment = document.createDocumentFragment();
  for (const run of formatRuns(value.text, value.format)) {
    const span = document.createElement('span');
    span.dataset.inlineStyle = String(run.style);
    Object.assign(span.style, styleFor(run.style));
    span.textContent = value.text.slice(run.start, run.end);
    fragment.append(span);
  }
  // A terminal newline needs a trailing line box for Chromium's caret.
  // It is presentation only; read() excludes this sentinel from saved text.
  if (value.text.endsWith('\n')) fragment.append(document.createElement('br'));
  root.replaceChildren(fragment);
}
function read(root: HTMLElement): Value {
  let text = '';
  const format: FormatRange[] = [];
  const visit = (node: Node, inherited: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const start = text.length;
      text += node.textContent || '';
      if (inherited && text.length > start)
        format.push({ start, end: text.length, style: inherited });
    } else if (node instanceof HTMLElement) {
      const style = Number(node.dataset.inlineStyle ?? inherited) & 7;
      if (node.tagName === 'BR') {
        if (node !== root.lastChild) text += '\n';
        return;
      }
      const block = node !== root && ['DIV', 'P'].includes(node.tagName);
      if (block && text && !text.endsWith('\n')) text += '\n';
      node.childNodes.forEach((child) => visit(child, style));
    }
  };
  visit(root, 0);
  return { text, format: formatRuns(text, format).filter((r) => r.style) };
}
/** A deliberately small plain-text editor with inline marks, not stored HTML. */
export function InlineEditor({
  value = '',
  format = [],
  onChange,
  label,
  placeholder = '',
  maxLength = 10000,
  autoFocus = false,
  multiline = true,
  className = '',
  onDone,
  onBlur,
}: {
  value?: string;
  format?: FormatRange[];
  onChange: (text: string, format: FormatRange[]) => void;
  label: string;
  placeholder?: string;
  maxLength?: number;
  autoFocus?: boolean;
  multiline?: boolean;
  className?: string;
  onDone?: () => void;
  onBlur?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const current = useRef<Value>({ text: value, format });
  const past = useRef<Snapshot[]>([]),
    future = useRef<Snapshot[]>([]);
  const remembered = useRef<Selection>({ start: 0, end: 0 });
  const composing = useRef(false);
  const [selected, setSelected] = useState<Selection>({ start: 0, end: 0 });
  const [active, setActive] = useState(0);
  const refresh = () => {
    if (!root.current) return;
    const s = selectionIn(root.current);
    if (!s) return;
    remembered.current = s;
    setSelected(s);
    const covered = formatRuns(current.current.text, current.current.format).filter(
      (r) => r.start < s.end && r.end > s.start,
    );
    setActive(covered.length ? covered.reduce((mask, r) => mask & r.style, 7) : 0);
  };
  // A missing/default format array is a new object on every local selection
  // render. Sync only when prop content changes, so a render with the parent's
  // previous text cannot overwrite a keystroke before its update arrives.
  const formatKey = JSON.stringify(format);
  useLayoutEffect(() => {
    const element = root.current!;
    const incoming = { text: value, format: formatRuns(value, format).filter((r) => r.style) };
    if (
      !element.hasAttribute('data-initialized') ||
      JSON.stringify(incoming) !== JSON.stringify(current.current)
    ) {
      const s = selectionIn(element);
      paint(element, incoming);
      current.current = incoming;
      past.current = [];
      future.current = [];
      if (s) restoreSelection(element, s);
      element.dataset.initialized = 'true';
    }
  }, [value, formatKey]);
  useEffect(() => {
    document.addEventListener('selectionchange', refresh);
    let frame = 0,
      attempts = 0;
    const focus = () => {
      const element = root.current;
      if (!element) return;
      if (getComputedStyle(element).visibility === 'hidden' && attempts++ < 20) {
        frame = requestAnimationFrame(focus);
        return;
      }
      // A click or keystroke may focus the editor before this delayed callback.
      // Keep that live caret instead of resetting it to the initial prop length.
      if (document.activeElement === element) {
        refresh();
        return;
      }
      element.focus({ preventScroll: true });
      const end = current.current.text.length;
      restoreSelection(element, { start: end, end });
      refresh();
    };
    if (autoFocus) frame = requestAnimationFrame(focus);
    return () => {
      document.removeEventListener('selectionchange', refresh);
      cancelAnimationFrame(frame);
    };
  }, []);
  const commit = (next: Value, s: Selection, before = remembered.current) => {
    const element = root.current!;
    next.text = next.text.slice(0, maxLength);
    next.format = formatRuns(next.text, next.format).filter((r) => r.style);
    if (JSON.stringify(next) !== JSON.stringify(current.current)) {
      past.current.push({ ...current.current, selection: before });
      if (past.current.length > 100) past.current.shift();
      future.current = [];
      current.current = next;
      onChange(next.text, next.format);
    }
    paint(element, next);
    restoreSelection(element, s);
    refresh();
  };
  const input = () => {
    if (composing.current) return;
    const element = root.current!;
    const next = read(element);
    commit(next, selectionIn(element) || { start: next.text.length, end: next.text.length });
  };
  const apply = (bit: number) => {
    const element = root.current!,
      s = selectionIn(element) || remembered.current;
    if (s.start === s.end) return;
    element.focus({ preventScroll: true });
    commit(
      {
        text: current.current.text,
        format: toggleFormat(current.current.text, current.current.format, s.start, s.end, bit),
      },
      s,
    );
  };
  const history = (redo: boolean) => {
    const from = redo ? future : past,
      to = redo ? past : future;
    const snapshot = from.current.pop();
    if (!snapshot) return;
    to.current.push({
      ...current.current,
      selection: selectionIn(root.current!) || remembered.current,
    });
    current.current = { text: snapshot.text, format: snapshot.format };
    paint(root.current!, current.current);
    restoreSelection(root.current!, snapshot.selection);
    onChange(snapshot.text, snapshot.format);
    refresh();
  };
  const insert = (text: string, insertedFormat?: FormatRange[]) => {
    const element = root.current!,
      s = selectionIn(element) || remembered.current;
    const available = Math.max(0, maxLength - current.current.text.length + s.end - s.start);
    text = (multiline ? text : text.replace(/[\r\n]+/g, ' ')).slice(0, available);
    element.focus();
    commit(
      replaceText(
        current.current.text,
        current.current.format,
        s.start,
        s.end,
        text,
        insertedFormat,
      ),
      { start: s.start + text.length, end: s.start + text.length },
      s,
    );
  };
  const copySelection = (e: ReactClipboardEvent<HTMLDivElement>, cut = false) => {
    const s = selectionIn(root.current!);
    if (!s || s.start === s.end) return;
    e.preventDefault();
    e.stopPropagation();
    const text = current.current.text.slice(s.start, s.end);
    const format = formatRuns(current.current.text, current.current.format)
      .filter((r) => r.start < s.end && r.end > s.start && r.style)
      .map((r) => ({
        start: Math.max(r.start, s.start) - s.start,
        end: Math.min(r.end, s.end) - s.start,
        style: r.style,
      }));
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData(
      'application/x-intelboard-inline+json',
      JSON.stringify({ text, format }),
    );

    if (cut)
      commit(
        replaceText(current.current.text, current.current.format, s.start, s.end, ''),
        { start: s.start, end: s.start },
        s,
      );
  };
  return (
    <div
      className={`inline-editor-wrap nodrag nopan nowheel ${className}`}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) onBlur?.();
      }}
    >
      <div className="inline-format-bar" role="toolbar" aria-label={`Format ${label}`}>
        {(
          [
            [1, 'Bold', 'B', Bold],
            [2, 'Italic', 'I', Italic],
            [4, 'Underline', 'U', Underline],
          ] as const
        ).map(([bit, name, key, Icon]) => (
          <button
            key={bit}
            type="button"
            aria-label={name}
            aria-pressed={!!(active & bit)}
            aria-keyshortcuts={`Control+${key} Meta+${key}`}
            title={`${name} (Ctrl/⌘+${key})`}
            disabled={selected.start === selected.end}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => apply(bit)}
          >
            <Icon size={14} />
          </button>
        ))}
        <span>Select text to format</span>
      </div>
      <div
        ref={root}
        className="inline-editor"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label={label}
        aria-multiline={multiline}
        data-placeholder={placeholder}
        spellCheck
        onInput={input}
        onBeforeInput={(e) => {
          const type = (e.nativeEvent as InputEvent).inputType;
          if (type === 'insertParagraph' || type === 'insertLineBreak') {
            e.preventDefault();
            if (multiline) insert('\n');
            else onDone?.();
          }
          if (type === 'historyUndo' || type === 'historyRedo') {
            e.preventDefault();
            history(type === 'historyRedo');
          }
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          input();
        }}
        onCopy={(e) => copySelection(e)}
        onCut={(e) => copySelection(e, true)}
        onPaste={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const text = e.clipboardData.getData('text/plain');
          let format: FormatRange[] | undefined;
          try {
            const rich = JSON.parse(
              e.clipboardData.getData('application/x-intelboard-inline+json'),
            );
            if (
              rich.text === text &&
              Array.isArray(rich.format) &&
              rich.format.length <= 10000 &&
              rich.format.every(
                (r: FormatRange) =>
                  Number.isInteger(r.start) &&
                  Number.isInteger(r.end) &&
                  r.start >= 0 &&
                  r.end > r.start &&
                  r.end <= text.length &&
                  Number.isInteger(r.style) &&
                  r.style >= 1 &&
                  r.style <= 7,
              )
            )
              format = rich.format;
          } catch {
            /* External clipboard content is inserted as plain text. */
          }
          insert(text, format);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing) return;
          const key = e.key.toLowerCase(),
            command = e.ctrlKey || e.metaKey;
          if (command && ['b', 'i', 'u'].includes(key)) {
            e.preventDefault();
            apply(key === 'b' ? 1 : key === 'i' ? 2 : 4);
          } else if (command && (key === 'z' || key === 'y')) {
            e.preventDefault();
            history(key === 'y' || e.shiftKey);
          } else if (key === 'enter') {
            e.preventDefault();
            if (multiline) insert('\n');
            else onDone?.();
          } else if (key === 'escape') {
            e.preventDefault();
            onDone?.();
          }
        }}
      />
    </div>
  );
}
