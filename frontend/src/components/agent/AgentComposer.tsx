import React from 'react';
import { Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface Example {
  text: string;
  icon: React.ReactNode;
}

interface AgentComposerProps {
  input: string;
  disabled: boolean;
  isLoading: boolean;
  showExamples: boolean;
  examples: Example[];
  onInputChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  onStop: () => void;
  onSearch: () => void;
  onSelectExample: (value: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function AgentComposer({
  input,
  disabled,
  isLoading,
  showExamples,
  examples,
  onInputChange,
  onKeyDown,
  onSubmit,
  onStop,
  onSearch,
  onSelectExample,
  inputRef,
}: AgentComposerProps) {
  void showExamples;
  void examples;
  void onSearch;
  void onSelectExample;

  return (
    <div className="bg-background/88 px-4 pb-4 pt-2 backdrop-blur-xl md:px-6">
      <div className="mx-auto flex w-full max-w-6xl items-end gap-2 rounded-[24px] bg-muted/58 px-3 py-2.5 transition-colors focus-within:bg-muted/72">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="输入你的分析任务"
            disabled={disabled}
            rows={2}
            className="min-h-[50px] flex-1 resize-none border-0 bg-transparent px-1.5 py-1.5 text-[14px] leading-6 text-foreground outline-none placeholder:text-[13px] placeholder:text-muted-foreground focus-visible:outline-none"
          />
          <Button
            type="button"
            className="h-11 shrink-0 gap-2 rounded-2xl bg-primary px-4.5 text-[13px] text-primary-foreground shadow-none hover:bg-primary/90"
            disabled={isLoading ? false : !input.trim() || disabled}
            onClick={isLoading ? onStop : onSubmit}
          >
            {isLoading ? '停止' : '发送'}
            {isLoading ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </Button>
      </div>

      <div className="mt-2 text-center text-[10px] text-muted-foreground">
        结果仅供参考，不构成投资建议
      </div>
    </div>
  );
}
