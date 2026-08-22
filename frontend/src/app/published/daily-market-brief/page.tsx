'use client';

import Link from 'next/link';
import React, { useEffect, useState } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || '/api/v1';

interface CollectionItem {
  entry_slug: string;
  title: string;
  published_at: string;
  url: string;
}

export default function DailyMarketBriefCollectionPage() {
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/reports/collections/daily-market-brief`);
        const json = await response.json();
        if (!active) return;
        if (json.success && json.data) {
          setItems((json.data.items || []) as CollectionItem[]);
        } else {
          setError(json.error || '加载合集失败');
        }
      } catch {
        if (active) {
          setError('加载合集失败');
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="mb-8">
        <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Published Collection</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-foreground">每日市场复盘</h1>
      </div>

      {error ? (
        <p className="text-sm text-muted-foreground">{error}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有已发布内容。</p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <Link
              key={item.entry_slug}
              href={`/published/daily-market-brief/${item.entry_slug}`}
              className="block rounded-2xl border border-border bg-card/90 px-4 py-3 transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              <div className="text-sm font-medium text-foreground">{item.title}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {new Date(item.published_at).toLocaleString()}
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
