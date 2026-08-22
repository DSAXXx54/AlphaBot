'use client';

import Link from 'next/link';
import React, { useEffect, useState } from 'react';
import { RichMarkdown } from '@/components/markdown/RichMarkdown';
import { normalizePublishedContent } from '@/app/published/content';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || '/api/v1';

interface PublishedPayload {
  slug: string;
  title: string;
  content: string;
  published_at: string;
  metadata?: Record<string, unknown>;
}

export default function DailyMarketBriefEntryPage({ params }: { params: Promise<{ entrySlug: string }> }) {
  const [payload, setPayload] = useState<PublishedPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const resolved = await params;
        const response = await fetch(`${API_BASE_URL}/reports/collections/daily-market-brief/${resolved.entrySlug}`);
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
      <main className="container mx-auto px-4 py-8">
        <h1 className="text-xl font-semibold text-foreground">发布内容不可用</h1>
        <p className="mt-3 text-sm text-muted-foreground">{error}</p>
      </main>
    );
  }

  if (!payload) {
    return (
      <main className="container mx-auto px-4 py-8">
        <p className="text-sm text-muted-foreground">正在加载发布内容...</p>
      </main>
    );
  }

  return (
    <main className="container mx-auto px-4 py-8">
      <div className="mx-auto mb-6 flex max-w-3xl items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold dark:text-white">{payload.title}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            发布时间：{new Date(payload.published_at).toLocaleString()}
          </p>
        </div>
        <Link href="/published/daily-market-brief">
          <Button variant="outline" size="sm" className="flex items-center">
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回日报
          </Button>
        </Link>
      </div>

      <div className="mx-auto max-w-3xl">
        <RichMarkdown
          content={normalizePublishedContent(payload.content)}
          className="prose prose-slate max-w-none dark:prose-invert"
        />

        <div className="mt-8 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm leading-6 text-muted-foreground">
          <div className="font-medium text-foreground">AlphaBot 声明</div>
          <p className="mt-1">
            本日报由 AlphaBot 基于公开市场数据、已启用技能与工具链自动生成，仅供研究与信息参考，不构成任何投资建议。
            市场有风险，决策请结合自身判断与风险承受能力。
          </p>
        </div>
      </div>
    </main>
  );
}
