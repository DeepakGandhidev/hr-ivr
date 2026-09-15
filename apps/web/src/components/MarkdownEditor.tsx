"use client";

import { useRef, useState } from "react";

/**
 * The JD body editor.
 *
 * Markdown with a formatting toolbar rather than a WYSIWYG surface, because
 * `bodyMd` is markdown everywhere else it is used — the careers page renders
 * it, and the screening prompt feeds it to the model as the role definition.
 * Storing HTML here would put every new JD in a different format from every
 * existing one, and the screening prompt would start reading tags as
 * requirements.
 *
 * The toolbar inserts the syntax around the selection, so nobody needs to know
 * markdown to make a heading, and the preview shows what it becomes.
 */
export default function MarkdownEditor({
  value,
  onChange,
  disabled,
  rows = 18,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  rows?: number;
  label?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [preview, setPreview] = useState(false);

  /** Wrap the selection, or insert a placeholder when nothing is selected. */
  function wrap(before: string, after = before, placeholder = "text") {
    const el = ref.current;
    if (!el) return;

    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end) || placeholder;
    const next = value.slice(0, start) + before + selected + after + value.slice(end);

    onChange(next);

    // Put the caret back around what was just wrapped, so the selection stays
    // usable instead of collapsing to the end of the document.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  }

  /** Prefix each selected line, for headings and lists. */
  function prefixLines(prefix: string | ((i: number) => string)) {
    const el = ref.current;
    if (!el) return;

    const start = value.lastIndexOf("\n", el.selectionStart - 1) + 1;
    const end = value.indexOf("\n", el.selectionEnd);
    const stop = end === -1 ? value.length : end;

    const block = value.slice(start, stop) || "text";
    const prefixed = block
      .split("\n")
      .map((line, i) => (typeof prefix === "string" ? prefix : prefix(i)) + line)
      .join("\n");

    onChange(value.slice(0, start) + prefixed + value.slice(stop));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start, start + prefixed.length);
    });
  }

  return (
    <div className="md-editor">
      <div className="md-toolbar">
        <button type="button" className="sm ghost" disabled={disabled || preview}
          onClick={() => wrap("**")} title="Bold"><strong>B</strong></button>
        <button type="button" className="sm ghost" disabled={disabled || preview}
          onClick={() => wrap("_")} title="Italic"><em>I</em></button>
        <button type="button" className="sm ghost" disabled={disabled || preview}
          onClick={() => prefixLines("## ")} title="Heading">H</button>
        <button type="button" className="sm ghost" disabled={disabled || preview}
          onClick={() => prefixLines("- ")} title="Bullet list">• List</button>
        <button type="button" className="sm ghost" disabled={disabled || preview}
          onClick={() => prefixLines((i) => `${i + 1}. `)} title="Numbered list">1. List</button>
        <button type="button" className="sm ghost" disabled={disabled || preview}
          onClick={() => wrap("[", "](https://)", "link text")} title="Link">Link</button>

        {/* A toggle rather than a second pane: side by side at this width would
            halve both, and the JD is the widest thing on the page. */}
        <button
          type="button"
          className={preview ? "sm" : "sm ghost"}
          style={{ marginLeft: "auto" }}
          onClick={() => setPreview((p) => !p)}
        >
          {preview ? "Edit" : "Preview"}
        </button>
      </div>

      {preview ? (
        <div className="md-preview">{renderMarkdown(value)}</div>
      ) : (
        <textarea
          ref={ref}
          aria-label={label ?? "Job description"}
          value={value}
          rows={rows}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          style={{ fontFamily: "inherit", lineHeight: 1.55 }}
        />
      )}
    </div>
  );
}

/**
 * A deliberately small markdown renderer for the preview.
 *
 * Returns React elements rather than an HTML string: the JD is editable by
 * anyone on the team, and handing user-authored text to dangerouslySetInnerHTML
 * would make the preview an XSS sink on a page admins use. Nothing here ever
 * interprets raw HTML, so the worst a hostile JD can do is look wrong.
 *
 * Supports what the toolbar writes — headings, bullet and numbered lists, bold,
 * italic and links. Anything else renders as its own literal text.
 */
function renderMarkdown(src: string) {
  const blocks: React.ReactNode[] = [];
  const lines = src.split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushList = (key: string) => {
    if (!list) return;
    const items = list.items.map((item, i) => <li key={i}>{inline(item)}</li>);
    blocks.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    list = null;
  };

  lines.forEach((line, i) => {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);

    if (bullet) {
      if (list && list.ordered) flushList(`l${i}`);
      list = list ?? { ordered: false, items: [] };
      list.items.push(bullet[1]);
      return;
    }
    if (numbered) {
      if (list && !list.ordered) flushList(`l${i}`);
      list = list ?? { ordered: true, items: [] };
      list.items.push(numbered[1]);
      return;
    }

    flushList(`l${i}`);

    if (heading) {
      const level = heading[1].length;
      const Tag = (level <= 2 ? "h3" : "h4") as "h3" | "h4";
      blocks.push(<Tag key={i}>{inline(heading[2])}</Tag>);
      return;
    }
    if (line.trim()) blocks.push(<p key={i}>{inline(line)}</p>);
  });

  flushList("last");
  return blocks.length ? blocks : <p className="subtle">Nothing to preview yet.</p>;
}

/** Bold, italic and links within one line. */
function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*)|(_([^_]+)_)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));

    if (m[2]) out.push(<strong key={m.index}>{m[2]}</strong>);
    else if (m[4]) out.push(<em key={m.index}>{m[4]}</em>);
    else if (m[6]) {
      // Only http(s). A `javascript:` href in a link the whole team can edit is
      // the same XSS the renderer otherwise avoids.
      const href = /^https?:\/\//i.test(m[7]) ? m[7] : undefined;
      out.push(
        href
          ? <a key={m.index} href={href} target="_blank" rel="noopener noreferrer">{m[6]}</a>
          : <span key={m.index}>{m[6]}</span>
      );
    }
    last = pattern.lastIndex;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}
