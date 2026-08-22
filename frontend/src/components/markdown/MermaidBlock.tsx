'use client';

import React, { useEffect, useId, useState } from 'react';

interface MermaidModule {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
}

interface MermaidBlockProps {
  code: string;
}

let mermaidLoader: Promise<MermaidModule> | null = null;

async function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then((module) => {
      const mermaid = (module.default || module) as MermaidModule;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: 'default',
      });
      return mermaid;
    });
  }
  return mermaidLoader;
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const reactId = useId();
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const mermaid = await loadMermaid();
        const { svg: rendered } = await mermaid.render(`mermaid-${reactId.replace(/:/g, '-')}`, code);
        if (!active) return;
        setSvg(rendered);
        setError(null);
      } catch (err) {
        if (!active) return;
        setSvg('');
        setError(err instanceof Error ? err.message : 'Mermaid 渲染失败');
      }
    })();

    return () => {
      active = false;
    };
  }, [code, reactId]);

  if (error) {
    return (
      <pre className="overflow-x-auto rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">
        {code}
      </pre>
    );
  }

  if (!svg) {
    return (
      <div className="rounded-2xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        正在渲染图表...
      </div>
    );
  }

  return (
    <div
      className="overflow-x-auto rounded-2xl border border-border bg-background p-3"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
