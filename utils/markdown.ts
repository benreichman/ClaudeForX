// Minimal markdown renderer for streaming output. Input is escaped first, so the
// produced HTML only ever contains tags we generate here.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMarkdown(src: string): string {
  let html = escapeHtml(src);

  // Fenced code blocks first so nothing inside them gets transformed.
  html = html.replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, (_m, code: string) => {
    return `<pre><code>${code}</code></pre>`;
  });

  html = html
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );

  // Unordered lists
  html = html.replace(/(?:^|\n)((?:[-*] .*(?:\n|$))+)/g, (_m, block: string) => {
    const items = block
      .trim()
      .split('\n')
      .map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`)
      .join('');
    return `\n<ul>${items}</ul>\n`;
  });

  // Ordered lists
  html = html.replace(/(?:^|\n)((?:\d+\. .*(?:\n|$))+)/g, (_m, block: string) => {
    const items = block
      .trim()
      .split('\n')
      .map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`)
      .join('');
    return `\n<ol>${items}</ol>\n`;
  });

  // Paragraphs: blank-line-separated chunks that aren't already block elements.
  return html
    .split(/\n{2,}/)
    .map((chunk) => {
      const trimmed = chunk.trim();
      if (!trimmed) return '';
      if (/^<(h\d|ul|ol|pre)/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}
