/**
 * Jira Cloud returns descriptions as Atlassian Document Format (a JSON tree);
 * Jira Server returns wiki-markup text. The report shows the first paragraph
 * of either, so both shapes collapse to one plain-text extractor.
 */

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

const BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'blockquote', 'codeBlock', 'panel',
  'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem',
]);

function nodeText(node: AdfNode): string {
  if (node.text) return node.text;

  switch (node.type) {
    case 'hardBreak':
      return ' ';
    case 'mention':
      return String(node.attrs?.text ?? '@mention');
    case 'emoji':
      return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
    case 'inlineCard':
    case 'blockCard':
      return String(node.attrs?.url ?? '');
    case 'date':
      return '';
    default:
      break;
  }

  return (node.content ?? []).map(nodeText).join('');
}

/** Every block of an ADF document as plain text, empty blocks dropped. */
function blocks(node: AdfNode): string[] {
  if (BLOCK_TYPES.has(node.type ?? '')) {
    const text = nodeText(node).replace(/\s+/g, ' ').trim();
    return text ? [text] : [];
  }
  return (node.content ?? []).flatMap(blocks);
}

const WIKI_MARKUP = [
  [/\{code(?::[^}]*)?\}[\s\S]*?\{code\}/g, ' '],
  [/\{noformat\}[\s\S]*?\{noformat\}/g, ' '],
  [/\[([^|\]]+)\|[^\]]+\]/g, '$1'],
  [/[*_+^~-]{1,2}(?=\S)([^*_+^~]+)(?<=\S)[*_+^~]{1,2}/g, '$1'],
  [/^h[1-6]\.\s*/gm, ''],
  [/^[*#-]+\s+/gm, ''],
] as const;

function fromWikiMarkup(text: string): string[] {
  let cleaned = text;
  for (const [pattern, replacement] of WIKI_MARKUP) cleaned = cleaned.replace(pattern, replacement);
  return cleaned
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** The description's first paragraph, or null when there is nothing to show. */
export function firstParagraph(description: unknown, maxLength = 400): string | null {
  if (description === null || description === undefined) return null;

  const found = typeof description === 'string'
    ? fromWikiMarkup(description)
    : blocks(description as AdfNode);

  const first = found[0];
  if (!first) return null;
  if (first.length <= maxLength) return first;

  // Trim at a word boundary so the summary does not end mid-word.
  const cut = first.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
