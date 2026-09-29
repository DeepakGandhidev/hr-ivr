"use client";

import { useRef, useState } from "react";
import Markdown from "@/components/Markdown";

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
  initialPreview = false,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  rows?: number;
  label?: string;
  /** Open on the rendered view, for screens where reading comes first. */
  initialPreview?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [preview, setPreview] = useState(initialPreview);

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
          onClick={() => wrap("**")} title="Bold" aria-label="Bold"><strong>B</strong></button>
        <button type="button" className="sm ghost" disabled={disabled || preview}
          onClick={() => wrap("_")} title="Italic" aria-label="Italic"><em>I</em></button>
        <button type="button" className="sm ghost" disabled={disabled || preview}
          onClick={() => prefixLines("## ")} title="Heading" aria-label="Heading">H</button>
        <button type="button" className="sm ghost" disabled={disabled || preview}
          onClick={() => prefixLines("- ")} title="Bullet list" aria-label="Bullet list">• List</button>
        <button type="button" className="sm ghost" disabled={disabled || preview}
          onClick={() => prefixLines((i) => `${i + 1}. `)} title="Numbered list" aria-label="Numbered list">1. List</button>
        <button type="button" className="sm ghost" disabled={disabled || preview}
          onClick={() => wrap("[", "](https://)", "link text")} title="Link" aria-label="Link">Link</button>

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
        <div className="md-preview">
          {value.trim() ? <Markdown source={value} /> : <p className="subtle">Nothing to preview yet.</p>}
        </div>
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
