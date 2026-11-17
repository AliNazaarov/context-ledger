// Paging of file text: the text fallbacks of latent_read and latent_transfer, and
// latent_transfer's text document.
import { cutText, maxResultCharacters, resultSize } from '../paging.mjs';
import { ToolError, briefingText, fromLineArgument, fromOffsetArgument, isObject, maxOffset, text, tooLarge } from './common.mjs';
import { ledger, olderLedger } from './ledger.mjs';
import { notesSize, partialPage } from './pages.mjs';

/** fromPath, fromLine and fromOffset for continuing a text fallback, or undefined. */
export function filePosition(args, paths) {
  const fromLine = fromLineArgument(args);
  const fromOffset = fromOffsetArgument(args);
  if (args.fromPath === undefined) {
    if (args.fromLine !== undefined || args.fromOffset !== undefined) throw new ToolError('fromLine and fromOffset need fromPath.');
    return undefined;
  }
  const index = typeof args.fromPath === 'string' && Array.isArray(paths) ? paths.indexOf(args.fromPath) : -1;
  if (index < 0) throw new ToolError('fromPath must be one of paths.');
  return { index, fromLine, fromOffset };
}

/** Split the ledger's numbered file text back into lines, checking the numbering. */
export function numberedFiles(data) {
  if (!isObject(data) || !Array.isArray(data.files)) return undefined;
  const files = [];
  for (const file of data.files) {
    if (!isObject(file) || typeof file.path !== 'string' || typeof file.text !== 'string') return undefined;
    const numbered = file.text === '' ? [] : file.text.split('\n');
    const lines = [];
    for (const [index, line] of numbered.entries()) {
      const prefix = `${index + 1}| `;
      if (!line.startsWith(prefix)) return undefined;
      lines.push(line.slice(prefix.length));
    }
    // A line resumed inside keeps a prefix too, `line+character| `, so file text never
    // starts a line of the page and cannot pass for a heading or another numbered line.
    files.push({ path: file.path, lines, prefix: (line, offset) => (offset ? `${line}+${offset}| ` : `${line}| `) });
  }
  return files;
}

/**
 * One page of file text: the intro, then each file from the start position, line by
 * line, each block as `=== FILE: path ===` and its lines. A line that does not fit
 * on an otherwise empty page is cut. next(position, filesAfter) is the continuation note,
 * which a partial page carries first and last.
 */
export function filePage({ intro, files, start, limit, next, heading }) {
  const pieces = [briefingText(intro)];
  let size = resultSize(pieces[0]);
  let shown = false;
  const footer = position => (position.file < files.length ? notesSize(next(position, files.length - position.file - 1)) : 0);
  const stop = position => partialPage(pieces.join(''), next(position, files.length - position.file - 1));
  for (let index = start.file; index < files.length; index += 1) {
    const file = files[index];
    const firstLine = index === start.file ? start.line : 1;
    const firstOffset = index === start.file ? start.offset : 0;
    const block = `\n\n${heading(file, firstLine, firstOffset)}\n`;
    if (!file.lines.length) {
      const cost = resultSize(briefingText(block));
      if (size + cost + footer({ file: index + 1, line: 1, offset: 0 }) > limit) {
        // Stop before this heading once the page holds anything; a heading that cannot
        // fit on an empty page means the page cannot be built.
        if (pieces.length > 1) return stop({ file: index, line: 1, offset: 0 });
        return undefined;
      }
      pieces.push(briefingText(block));
      size += cost;
      continue;
    }
    for (let line = firstLine; line <= file.lines.length; line += 1) {
      const offset = line === firstLine ? firstOffset : 0;
      const lead = line === firstLine ? block : '\n';
      const raw = file.lines[line - 1];
      const prefix = file.prefix(line, offset);
      const after = line < file.lines.length ? { file: index, line: line + 1, offset: 0 } : { file: index + 1, line: 1, offset: 0 };
      const piece = briefingText(lead + prefix + raw.slice(offset));
      const pieceSize = resultSize(piece);
      if (size + pieceSize + footer(after) <= limit) {
        pieces.push(piece);
        size += pieceSize;
        shown = true;
        continue;
      }
      if (shown) return stop({ file: index, line, offset });
      // Alone on the page and still too long: cut the line.
      const leadText = briefingText(lead + prefix);
      const measure = end => size + resultSize(leadText) + resultSize(briefingText(raw.slice(offset, end)))
        + footer({ file: index, line, offset: end });
      const end = cutText(raw, offset, limit, measure, Math.min(raw.length - 1, offset + 2 * limit + 2));
      if (end >= raw.length || measure(end) > limit) return undefined;
      pieces.push(leadText + briefingText(raw.slice(offset, end)));
      return stop({ file: index, line, offset: end });
    }
  }
  return pieces.join('');
}

export const fileHeading = (file, line, offset) => (line === 1 && offset === 0 ? `=== FILE: ${file.path} ===`
  : `=== FILE: ${file.path} (continued from line ${line}${offset ? `, character ${offset}` : ''}) ===`);
export const textHeading = (_file, line, offset) => (line === 1 && offset === 0 ? '=== TEXT ==='
  : `=== TEXT (continued from line ${line}${offset ? `, character ${offset}` : ''}) ===`);
export const reread = 'Files are read again on each call; if they changed, line numbers may have shifted.';

/**
 * A text fallback of latent_read or latent_transfer, paged. same names the arguments
 * to repeat. position is where to start, or undefined for the first page.
 */
export function fallbackPage(name, { intro, files, position, same }) {
  const start = { file: 0, line: position?.fromLine ?? 1, offset: position?.fromOffset ?? 0 };
  const [first] = files;
  let lead = intro;
  if (position) {
    if (start.offset > 0 && start.offset >= (first.lines[start.line - 1]?.length ?? 0)) {
      if (start.line > first.lines.length) throw new ToolError('fromOffset needs fromLine to be a line of that file.');
      throw new ToolError('fromOffset is past the end of that line.');
    }
    if (start.line > Math.max(first.lines.length, 1)) {
      lead += `\n\n[No lines at or after line ${start.line} of ${JSON.stringify(first.path)}; it has ${first.lines.length} lines.]`;
      Object.assign(start, { file: 1, line: 1, offset: 0 });
    }
  }
  const next = (at, after) => `More file text remains (${after} more files after this one). Call ${name} again with ${same}, ` +
    `and fromPath ${JSON.stringify(files[at.file].path)}, fromLine ${at.line}${at.offset ? `, fromOffset ${at.offset}` : ''}.`;
  const page = filePage({ intro: lead, files, start, limit: maxResultCharacters, next, heading: fileHeading });
  if (page === undefined) throw tooLarge(name);
  return { content: [text(page)] };
}

export const unexpectedLatent = () => new ToolError('Context Ledger returned an unexpected latent response.');

/** The ledger's text fallback: whole when it fits, else its first page. */
export function textFallback(name, data, intro, same) {
  const whole = briefingText(`${intro}\n\n${data.files.map(file => `=== FILE: ${file.path} ===\n${file.text}`).join('\n\n')}`);
  if (resultSize(whole) <= maxResultCharacters) return { content: [text(whole)] };
  const files = numberedFiles(data);
  if (!files?.length) throw unexpectedLatent();
  return fallbackPage(name, { intro, files, position: undefined, same });
}

/** A later page of a text fallback. The files are read again; the model is not asked again. */
export async function continueFiles(name, paths, position, same) {
  const data = await ledger('/api/latent/files', { body: JSON.stringify({ paths: paths.slice(position.index) }), notFound: olderLedger });
  const files = numberedFiles(data);
  if (data?.mode !== 'text' || !files?.length || files[0].path !== paths[position.index]) throw unexpectedLatent();
  return fallbackPage(name, { intro: `${reread} Read the numbered files below.`, files, position, same });
}

/** A page of latent_transfer's text document, cut here from the text itself. */
export function transferTextPage(document, intro, position, same) {
  const lines = document.replace(/\r\n/g, '\n').split('\n');
  const start = { file: 0, line: position?.fromLine ?? 1, offset: position?.fromOffset ?? 0 };
  if (position) {
    if (start.line > lines.length) {
      return { content: [text(briefingText(`${intro}\n\n[No lines at or after line ${start.line}; the text has ${lines.length} lines.]`))] };
    }
    if (start.offset > 0 && start.offset >= lines[start.line - 1].length) throw new ToolError('fromOffset is past the end of that line.');
  }
  const next = at => `More text remains. Call latent_transfer again with ${same}, ` +
    `and fromLine ${at.line}${at.offset ? `, fromOffset ${at.offset}` : ''}.`;
  const page = filePage({ intro, files: [{ path: 'text', lines, prefix: () => '' }], start, limit: maxResultCharacters, next, heading: textHeading });
  if (page === undefined) throw tooLarge('latent_transfer');
  return { content: [text(page)] };
}

export const continuationSchema = {
  fromPath: { type: 'string', description: 'Continue a long text fallback at this path, as its note says.' },
  fromLine: { type: 'integer', minimum: 1, description: 'Line to continue at.' },
  fromOffset: { type: 'integer', minimum: 0, maximum: maxOffset, description: 'Character in that line.' },
};
