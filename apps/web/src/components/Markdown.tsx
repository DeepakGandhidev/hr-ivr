import type { ReactNode } from "react";

/**
 * Markdown, rendered.
 *
 * JD bodies and the model-written parts of interview reports are stored as
 * markdown, and several screens printed them raw: hash signs, double
 * asterisks, dashes and dividers where headings, bold and lists should be.
 * This is the one renderer for all of them, so a fix here fixes every screen.
 *
 * Returns React elements, never an HTML string. JDs are editable by the whole
 * team and reports are model output; handing either to dangerouslySetInnerHTML
 * would make every page that shows them an XSS sink. Raw HTML in the source is
 * shown as text, and only http(s) and mailto links become anchors.
 *
 * No hooks, so it works in server and client components alike.
 *
 * Supported: headings (# and === underlines), paragraphs, bold, italics,
 * bold-italics, strikethrough, inline code, links and <https://…> autolinks,
 * bullet and numbered lists (one level of nesting), dividers, blockquotes,
 * fenced code and simple pipe tables. Single newlines inside a paragraph are
 * kept as line breaks, because model output uses them for "Location: …" style
 * lines that would otherwise run together. Images show their alt text: a JD
 * has no business loading third-party pixels into the portal.
 *
 * Stored text is not always clean markdown, and existing rows have to render
 * too, so normalize() first undoes what the generators and earlier editors
 * left behind: a whole JD wrapped in a ```markdown fence, <br> tags, and
 * newlines stored as a literal backslash-n.
 */
export default function Markdown({
  source,
  className,
  inline = false,
}: {
  source: string | null | undefined;
  className?: string;
  /** Render inline only (no blocks), for one-line strings such as list items. */
  inline?: boolean;
}) {
  const text = normalize(source);
  if (inline) {
    return <span className={className}>{renderInline(stripBlockMarkers(text), "i")}</span>;
  }
  return <div className={`md${className ? ` ${className}` : ""}`}>{renderBlocks(text)}</div>;
}

// ---------------------------------------------------------------------------
// Normalizing stored text
// ---------------------------------------------------------------------------

/** A fence around the whole document, whatever its language tag. */
const WHOLE_FENCE = /^(```|~~~)[^\n]*\n([\s\S]*?)\n?\1\s*$/;

function normalize(source: string | null | undefined): string {
  let text = String(source ?? "").replace(/\r\n?/g, "\n");
  // Double-encoded JSON leaves "\n" as two characters. Only when there is no
  // real newline at all, so a JD that merely mentions "\n" is left alone.
  if (!text.includes("\n") && /\\n/.test(text)) text = text.replace(/\\r\\n|\\n/g, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  const whole = WHOLE_FENCE.exec(text.trim());
  return whole ? whole[2] : text;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
/** The === underline that makes the line above it a heading. */
const SETEXT = /^\s{0,3}={2,}\s*$/;
/**
 * "# Title", or "##Title" with no space, which models do write. A single "#"
 * needs the space: "#hiring #sales" at the foot of a JD is hashtags.
 */
const HEADING = /^\s{0,3}(#[ \t]+|#{2,6}[ \t]*)(.*?)\s*#*\s*$/;
const HEADING_MARK = /^\s{0,3}(?:#[ \t]+|#{2,6}[ \t]*)/;
const BULLET = /^(\s*)[-*+•]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)\s*([\w-]*)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

interface ListItem {
  text: string;
  children: { ordered: boolean; items: string[] } | null;
}

function renderBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const k = () => `b${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code: everything to the closing fence, verbatim — unless the
    // fence says it holds markdown, which is the model wrapping its own prose.
    if (FENCE.test(line)) {
      const [, fence, lang] = FENCE.exec(line)!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i++;
      if (/^(markdown|md)$/i.test(lang)) out.push(...renderBlocks(body.join("\n")));
      else out.push(<pre key={k()}><code>{body.join("\n")}</code></pre>);
      continue;
    }

    if (line.trim() && SETEXT.test(lines[i + 1] ?? "") && !startsBlock(line, undefined)) {
      out.push(<h3 key={k()}>{renderInline(line.trim(), k())}</h3>);
      i += 2;
      continue;
    }

    // A divider, or an === underline with nothing above it to make a heading.
    if (HR.test(line) || SETEXT.test(line)) {
      out.push(<hr key={k()} />);
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading && heading[2]) {
      const level = heading[1].trim().length;
      const Tag = (level <= 2 ? "h3" : level === 3 ? "h4" : "h5") as "h3" | "h4" | "h5";
      out.push(<Tag key={k()}>{renderInline(heading[2], k())}</Tag>);
      i++;
      continue;
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(splitRow(lines[i++]));
      const tk = k();
      out.push(
        <div key={tk} className="md-table">
          <table>
            <thead>
              <tr>{head.map((c, ci) => <th key={ci} scope="col">{renderInline(c, `${tk}h${ci}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci}>{renderInline(c, `${tk}r${ri}c${ci}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
      out.push(<blockquote key={k()}>{renderBlocks(body.join("\n"))}</blockquote>);
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = !BULLET.test(line);
      const baseIndent = indentOf(line);
      const items: ListItem[] = [];

      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          // A blank line ends the list unless the next line continues the
          // same kind of list.
          const next = lines[i + 1] ?? "";
          if (ordered ? NUMBERED.test(next) : BULLET.test(next)) {
            i++;
            continue;
          }
          break;
        }
        const b = BULLET.exec(l);
        const n = NUMBERED.exec(l);
        const marker = b ?? n;
        if (marker) {
          const indent = indentOf(l);
          const text = b ? b[2] : n![3];
          // A top-level marker of the other kind starts a new list.
          if (indent <= baseIndent + 1 && Boolean(b) === ordered) break;
          if (indent > baseIndent + 1 && items.length > 0) {
            const parent = items[items.length - 1];
            parent.children = parent.children ?? { ordered: !b, items: [] };
            parent.children.items.push(text);
          } else {
            items.push({ text, children: null });
          }
          i++;
          continue;
        }
        // A plain line under an item continues that item's text.
        if (items.length > 0 && indentOf(l) > baseIndent) {
          items[items.length - 1].text += `\n${l.trim()}`;
          i++;
          continue;
        }
        break;
      }

      const lk = k();
      const rendered = items.map((item, ii) => (
        <li key={ii}>
          {renderInline(item.text, `${lk}i${ii}`)}
          {item.children &&
            (item.children.ordered ? (
              <ol>{item.children.items.map((c, ci) => <li key={ci}>{renderInline(c, `${lk}i${ii}c${ci}`)}</li>)}</ol>
            ) : (
              <ul>{item.children.items.map((c, ci) => <li key={ci}>{renderInline(c, `${lk}i${ii}c${ci}`)}</li>)}</ul>
            ))}
        </li>
      ));
      out.push(ordered ? <ol key={lk}>{rendered}</ol> : <ul key={lk}>{rendered}</ul>);
      continue;
    }

    // Paragraph: runs until a blank line or the start of another block.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) break;
      if (para.length > 0 && (startsBlock(l, lines[i + 1]) || SETEXT.test(lines[i + 1] ?? ""))) break;
      para.push(l.trim());
      i++;
    }
    const pk = k();
    out.push(
      <p key={pk}>
        {para.map((l, li) => (
          <span key={li}>
            {li > 0 && <br />}
            {renderInline(l, `${pk}l${li}`)}
          </span>
        ))}
      </p>
    );
  }

  return out;
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    HR.test(line) ||
    (HEADING.test(line) && Boolean(HEADING.exec(line)?.[2])) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    QUOTE.test(line) ||
    FENCE.test(line) ||
    (TABLE_ROW.test(line) && next !== undefined && TABLE_SEP.test(next))
  );
}

function indentOf(line: string): number {
  const m = /^(\s*)/.exec(line);
  return (m?.[1] ?? "").replace(/\t/g, "  ").length;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/**
 * One pattern, alternatives in priority order. Underscore emphasis only counts
 * at word boundaries, so snake_case identifiers and file names survive.
 */
const INLINE =
  /(`+)([^`]+?)\1|\*\*\*([^*\n]+?)\*\*\*|\*\*([^\n]+?)\*\*|__([^_\n]+?)__|(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)|\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)|\\([\\`*_{}[\]()#+\-.!|>~])|~~(?!\s)([^~\n]+?)~~|!\[([^\]\n]*)\]\([^)\n]*\)|<((?:https?:\/\/|mailto:)[^>\s]+)>/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const key = () => `${keyBase}-${n++}`;
  const re = new RegExp(INLINE.source, "g");
  let m: RegExpExecArray | null;

  const pushText = (s: string) => {
    if (!s) return;
    // Markers left unpaired by a malformed source (a stray "**", "__" or "~~")
    // are syntax, not content; showing them is exactly the bug being fixed.
    const cleaned = s.replace(/\*\*+|__+|~~+/g, "");
    if (cleaned) out.push(cleaned);
  };

  while ((m = re.exec(text))) {
    if (m.index > last) pushText(text.slice(last, m.index));

    if (m[2] !== undefined) {
      out.push(<code key={key()}>{m[2]}</code>);
    } else if (m[3] !== undefined) {
      out.push(<strong key={key()}><em>{renderInline(m[3].trim(), key())}</em></strong>);
    } else if (m[4] !== undefined) {
      out.push(<strong key={key()}>{renderInline(m[4].trim(), key())}</strong>);
    } else if (m[5] !== undefined) {
      out.push(<strong key={key()}>{renderInline(m[5].trim(), key())}</strong>);
    } else if (m[7] !== undefined) {
      if (m[6]) pushText(m[6]);
      out.push(<em key={key()}>{renderInline(m[7], key())}</em>);
    } else if (m[9] !== undefined) {
      if (m[8]) pushText(m[8]);
      out.push(<em key={key()}>{renderInline(m[9], key())}</em>);
    } else if (m[10] !== undefined) {
      const href = /^(https?:\/\/|mailto:)/i.test(m[11]) ? m[11] : undefined;
      out.push(
        href ? (
          <a key={key()} href={href} target="_blank" rel="noopener noreferrer">
            {renderInline(m[10], key())}
          </a>
        ) : (
          <span key={key()}>{renderInline(m[10], key())}</span>
        )
      );
    } else if (m[12] !== undefined) {
      out.push(m[12]);
    } else if (m[13] !== undefined) {
      out.push(<del key={key()}>{renderInline(m[13], key())}</del>);
    } else if (m[14] !== undefined) {
      if (m[14].trim()) out.push(m[14].trim());
    } else if (m[15] !== undefined) {
      out.push(
        <a key={key()} href={m[15]} target="_blank" rel="noopener noreferrer">
          {m[15].replace(/^mailto:/i, "")}
        </a>
      );
    }
    last = re.lastIndex;
  }

  if (last < text.length) pushText(text.slice(last));
  return out;
}

/** Heading, list and quote markers at the start of a line, for inline use. */
function stripBlockMarkers(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(HEADING_MARK, "").replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/, "").replace(/^\s{0,3}>\s?/, ""))
    .filter((l) => !HR.test(l))
    .join(" ")
    .trim();
}

// ---------------------------------------------------------------------------
// Plain text, for one-line previews
// ---------------------------------------------------------------------------

/** The same text with the syntax removed: for previews, titles and copy. */
export function markdownToPlain(src: string | null | undefined): string {
  return normalize(src)
    .split("\n")
    .filter((l) => !HR.test(l) && !TABLE_SEP.test(l) && !SETEXT.test(l) && !/^\s{0,3}(```|~~~)[\w-]*\s*$/.test(l))
    .map((l) =>
      l
        .replace(HEADING_MARK, "")
        .replace(/^\s{0,3}>\s?/, "")
        .replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/, "")
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .replace(/\s*\|\s*/g, " · ")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/gi, "$1")
        .replace(/~~/g, "")
        .replace(/`+([^`]+)`+/g, "$1")
        .replace(/\*\*\*|\*\*|__/g, "")
        .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, "$1$2")
        .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1$2")
        .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
        .trim()
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The first non-empty line, as plain text. */
export function firstLine(src: string | null | undefined): string {
  return markdownToPlain(src).split("\n").find((l) => l.trim()) ?? "";
}

/** The first sentence, as plain text: the recommendation's one-line takeaway. */
export function firstSentence(src: string | null | undefined): string {
  const plain = markdownToPlain(src).replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(plain);
  return (m ? m[1] : plain).trim();
}

/**
 * Cut from the END, always starting at the first word: a preview that begins
 * mid-sentence cannot be read.
 */
export function truncateEnd(text: string | null | undefined, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * Sentences of a plain-text passage. Used where a screening reason is the only
 * evidence available and needs listing line by line.
 */
export function sentencesOf(src: string | null | undefined): string[] {
  const plain = markdownToPlain(src).replace(/\s+/g, " ").trim();
  if (!plain) return [];
  return (plain.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [plain]).map((s) => s.trim()).filter(Boolean);
}
