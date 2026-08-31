function isMetaLine(line: string): boolean {
  return line === 'Published Report' || /^发布时间[:：]/.test(line);
}

function isMarkdownH1(line: string): boolean {
  return /^#(?!#)\s+/.test(line.trim());
}

export function normalizePublishedContent(content: string): string {
  const lines = content.split(/\r?\n/);

  while (lines.length > 0 && !lines[0].trim()) {
    lines.shift();
  }

  let removedTitle = false;

  while (lines.length > 0) {
    const current = lines[0].trim();
    if (!current) {
      lines.shift();
      continue;
    }

    if (isMetaLine(current)) {
      lines.shift();
      continue;
    }

    if (!removedTitle && isMarkdownH1(current)) {
      lines.shift();
      removedTitle = true;
      continue;
    }

    break;
  }

  while (lines.length > 0 && !lines[0].trim()) {
    lines.shift();
  }

  return lines.join('\n');
}

export function hasDisclaimerContent(content: string): boolean {
  const normalized = String(content || '').replace(/\s+/g, '');
  return (
    normalized.includes('免责申明') ||
    normalized.includes('免责声明') ||
    (normalized.includes('仅供研究参考') && normalized.includes('不构成投资建议')) ||
    (normalized.includes('市场有风险') && normalized.includes('投资需谨慎'))
  );
}
