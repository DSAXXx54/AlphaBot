'use client';

import React, { useEffect, useState } from 'react';
import { RichMarkdown } from '@/components/markdown/RichMarkdown';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || '/api/v1';

interface PublishedPayload {
  slug: string;
  title: string;
  content: string;
  published_at: string;
  metadata?: Record<string, unknown>;
}

export default function PublishedReportPage({ params }: { params: Promise<{ slug: string }> }) {
  const [payload, setPayload] = useState<PublishedPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const resolved = await params;
        const response = await fetch(`${API_BASE_URL}/reports/published/${resolved.slug}`);
        const json = await response.json();
        if (!active) return;
        if (json.success && json.data) {
          setPayload(json.data as PublishedPayload);
        } else {
          setError(json.error || '内容不存在');
        }
      } catch {
        if (active) {
          setError('加载发布内容失败');
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [params]);

  if (error) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-xl font-semibold text-foreground">发布内容不可用</h1>
        <p className="mt-3 text-sm text-muted-foreground">{error}</p>
      </main>
    );
  }

  if (!payload) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-12">
        <p className="text-sm text-muted-foreground">正在加载发布内容...</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="mb-8">
        <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Published Report</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-foreground">{payload.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          发布时间：{new Date(payload.published_at).toLocaleString()}
        </p>
      </div>

      <RichMarkdown content={payload.content} className="prose prose-slate max-w-none dark:prose-invert" />
    </main>
  );
}
