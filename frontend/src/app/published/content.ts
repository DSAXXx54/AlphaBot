function isMetaLine(line: string): boolean {
  return line === 'Published Report' || /^发布时间[:：]/.test(line);
}

function isReportTitleLine(line: string): boolean {
  const normalized = line.replace(/^#+\s*/, '').trim();
  if (!normalized) {
    return false;
  }

  if (normalized.length > 48) {
    return false;
  }

  return (
    /(?:报告|复盘|日报|简报)$/.test(normalized) ||
    /(?:报告|复盘|日报|简报)/.test(normalized) && /\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2})?/.test(normalized)
  );
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

    if (!removedTitle && isReportTitleLine(current)) {
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
