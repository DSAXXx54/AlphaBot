import React from 'react';
import { BrainCircuit, CheckCircle2, CircleDashed, Flag, OctagonAlert, Wrench } from 'lucide-react';
import { AgentRunEvent } from '@/types/agent';

interface AgentExecutionTimelineProps {
  events: AgentRunEvent[];
}

const iconMap = {
  goal: Flag,
  thinking: BrainCircuit,
  phase: CircleDashed,
  tool_call: Wrench,
  tool_result: CheckCircle2,
  answer: CheckCircle2,
  status: CircleDashed,
  error: OctagonAlert,
} as const;

const colorMap = {
  pending: 'border-border bg-muted text-muted-foreground',
  running: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  done: 'border-primary/20 bg-primary/10 text-primary',
  error: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
};

export function AgentExecutionTimeline({ events }: AgentExecutionTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-border p-4 text-sm text-muted-foreground">
        任务开始后，这里会显示 agent 的目标、推理阶段、工具调用和结果回传。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {events.map((event) => {
        const Icon = iconMap[event.type];
        const colorClass = colorMap[event.status || 'pending'];
        return (
          <div key={event.id} className="flex gap-3">
            <div className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-2xl border ${colorClass}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1 rounded-3xl border border-border bg-card/95 px-4 py-3 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{event.title}</div>
                  {event.detail && (
                    <div className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                      {event.detail}
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-[11px] tracking-[0.14em] text-muted-foreground">
                  {event.status || 'pending'}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
