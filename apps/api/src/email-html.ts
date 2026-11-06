const allowedTags = new Set([
  'p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
  'ul', 'ol', 'li', 'blockquote', 'a', 'span', 'font', 'img',
]);

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function safeStyle(value: string): string {
  const declarations: string[] = [];
  for (const part of value.split(';')) {
    const [rawName, ...rawValue] = part.split(':');
    const name = rawName?.trim().toLowerCase();
    const setting = rawValue.join(':').trim();
    if (!setting || /url\s*\(|expression|[<>]/i.test(setting)) continue;
    if (name === 'color' && /^(#[\da-f]{3,8}|[a-z]{3,20}|rgb\(\s*[\d%,.\s]+\))$/i.test(setting)) declarations.push(`color:${setting}`);
    if (name === 'font-family' && /^[\w\s,"'-]{1,60}$/.test(setting)) declarations.push(`font-family:${setting}`);
    if (name === 'font-size' && /^(xx-small|x-small|small|medium|large|x-large|xx-large|[1-7])$/i.test(setting)) declarations.push(`font-size:${setting}`);
    if (name === 'text-align' && /^(left|right|center|justify)$/i.test(setting)) declarations.push(`text-align:${setting}`);
  }
  return declarations.join(';');
}

function safeHref(value: string): string | null {
  const href = value.trim();
  if (/^(https?:|mailto:)/i.test(href)) return href;
  return null;
}

/** Allow only simple formatting produced by the compose editor; all text and attributes are rebuilt. */
export function sanitizeMessageHtml(input: string): string {
  const tokens = input.match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]*>|[^<]+|</g) ?? [];
  const output: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('<!--') || /^<!/i.test(token)) continue;
    const match = token.match(/^<\s*(\/?)\s*([a-z][a-z0-9]*)\b([^>]*)>$/i);
    if (!match) {
      output.push(escapeText(token));
      continue;
    }
    const [, closing, rawTag, rawAttributes] = match;
    const tag = rawTag.toLowerCase();
    if (!allowedTags.has(tag)) continue;
    if (closing) { output.push(`</${tag}>`); continue; }

    const attributes: string[] = [];
    const href = rawAttributes.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (tag === 'a' && href) {
      const safe = safeHref(href);
      if (safe) attributes.push(`href="${escapeText(safe).replace(/"/g, '&quot;')}"`, 'rel="noopener noreferrer"');
    }
    const src = rawAttributes.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (tag === 'img' && src && /^cid:[\da-f-]{36}$/i.test(src)) attributes.push(`src="${src}"`);
    if (tag === 'img') {
      const alt = rawAttributes.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2];
      if (alt) attributes.push(`alt="${escapeText(alt).replace(/"/g, '&quot;')}"`);
    }
    const style = rawAttributes.match(/\bstyle\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (style) {
      const safe = safeStyle(style);
      if (safe) attributes.push(`style="${safe.replace(/"/g, '&quot;')}"`);
    }
    if (tag === 'font') {
      const face = rawAttributes.match(/\bface\s*=\s*(["'])(.*?)\1/i)?.[2];
      const size = rawAttributes.match(/\bsize\s*=\s*(["']?)([1-7])\1/i)?.[2];
      const color = rawAttributes.match(/\bcolor\s*=\s*(["'])(.*?)\1/i)?.[2];
      if (face && /^[\w\s,"'-]{1,60}$/.test(face)) attributes.push(`face="${face.replace(/"/g, '&quot;')}"`);
      if (size) attributes.push(`size="${size}"`);
      if (color && /^(#[\da-f]{3,8}|[a-z]{3,20})$/i.test(color)) attributes.push(`color="${color}"`);
    }
    output.push(`<${tag}${attributes.length ? ` ${attributes.join(' ')}` : ''}${tag === 'br' || tag === 'img' ? ' />' : '>'}`);
  }
  return output.join('').slice(0, 200_000);
}
