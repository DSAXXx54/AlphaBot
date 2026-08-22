import React from 'react';
import { Bot, BrainCircuit, Globe, MessageSquareText, PanelRightOpen, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ModelOption {
  value: string;
  label: string;
}

interface AgentWorkspaceHeaderProps {
  currentSession: string | null;
  isLoadingSession: boolean;
  isLoading: boolean;
  activeSkillName?: string | null;
  streamEnabled: boolean;
  webSearchEnabled: boolean;
  canUseWebSearch: boolean;
  canAccessAutomation?: boolean;
  model: string | null;
  availableModels: ModelOption[];
  onModelChange: (value: string | null) => void;
  onToggleStream: () => void;
  onToggleWebSearch: () => void;
  onOpenRuns: () => void;
  onOpenInspector: () => void;
}

export function AgentWorkspaceHeader({
  currentSession,
  isLoadingSession,
  isLoading,
  activeSkillName,
  streamEnabled,
  webSearchEnabled,
  canUseWebSearch,
  canAccessAutomation = false,
  model,
  availableModels,
  onModelChange,
  onToggleStream,
  onToggleWebSearch,
  onOpenRuns,
  onOpenInspector,
}: AgentWorkspaceHeaderProps) {
  const statusText = isLoadingSession
    ? '正在加载任务'
    : isLoading
      ? 'Agent 正在执行'
      : currentSession
        ? '任务已就绪'
        : '等待新任务';

  return (
    <header className="bg-background/88 px-4 py-3 backdrop-blur md:px-6">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Bot className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[1rem] font-semibold tracking-[-0.03em] text-foreground sm:text-[1.05rem]">AlphaBot Agent</h1>
              <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary">
                {statusText}
              </span>
              {activeSkillName ? (
                <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium text-emerald-600">
                  custom skill · {activeSkillName}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 max-w-xl text-[11px] leading-4 text-muted-foreground sm:text-[12px]">
              查看分析过程、工具轨迹和结论。
            </p>
            <div className="mt-3 flex items-center gap-2 md:hidden">
              <Button variant="outline" size="sm" className="gap-2 rounded-2xl border-transparent bg-muted/70 hover:bg-muted" onClick={onOpenRuns}>
                <MessageSquareText className="h-4 w-4" />
                任务列表
              </Button>
              {canAccessAutomation ? (
                <Button variant="outline" size="sm" className="gap-2 rounded-2xl border-transparent bg-muted/70 hover:bg-muted" onClick={onOpenInspector}>
                  <PanelRightOpen className="h-4 w-4" />
                  运行上下文
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 items-center gap-2 rounded-2xl bg-muted/65 px-3 py-2 text-[11px] text-muted-foreground">
            <BrainCircuit className="h-4 w-4" />
            <select
              value={model ?? ''}
              onChange={(e) => onModelChange(e.target.value || null)}
              className="max-w-[170px] bg-transparent text-[12px] text-foreground outline-none sm:max-w-[220px]"
              title="选择模型"
            >
              {availableModels.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <Button variant={webSearchEnabled ? 'primary' : 'outline'} size="sm" className={`h-10 gap-2 rounded-2xl px-3.5 text-[12px] ${webSearchEnabled ? '' : 'border-transparent bg-muted/65 text-foreground hover:bg-muted hover:text-foreground'}`} disabled={!canUseWebSearch} onClick={onToggleWebSearch}>
            <Globe className="h-4 w-4" />
            联网搜索
          </Button>

          <Button variant={streamEnabled ? 'primary' : 'outline'} size="sm" className={`h-10 gap-2 rounded-2xl px-3.5 text-[12px] ${streamEnabled ? '' : 'border-transparent bg-muted/65 text-foreground hover:bg-muted hover:text-foreground'}`} onClick={onToggleStream}>
            <Sparkles className="h-4 w-4" />
            流式执行
          </Button>
        </div>
      </div>
    </header>
  );
}
