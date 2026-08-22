import React from 'react';
import { Bot, User } from 'lucide-react';
import { Message } from '../../types/chat';
import { Card } from '../ui/card';
import { RichMarkdown } from '../markdown/RichMarkdown';
import { ScrollArea } from '../ui/scroll-area';

interface AgentMessageDisplayProps {
  message: Message;
  isLast: boolean;
}

// Utility function for class names
const cn = (...classes: string[]) => classes.filter(Boolean).join(' ');

export function AgentMessageDisplay({ message, isLast }: AgentMessageDisplayProps) {
  void isLast;
  const isUser = message.role === 'user';
  const isAgent = message.role === 'assistant';
  
  // 渲染工具输出结果
  const renderToolOutputs = () => {
    if (!message.toolOutputs || message.toolOutputs.length === 0) {
      return null;
    }
    
    return (
      <div className="mt-2 space-y-2">
        {message.toolOutputs.map((output: string, index: number) => (
          <Card key={index} className="rounded-2xl border-border bg-muted/60 p-2.5 text-sm shadow-none">
            <details>
              <summary className="cursor-pointer select-none text-xs font-medium text-foreground transition-colors hover:text-primary">
                工具输出 {index + 1}
              </summary>
              <ScrollArea className="mt-2 max-h-64">
                <RichMarkdown content={output} className="prose prose-sm max-w-none dark:prose-invert" />
              </ScrollArea>
            </details>
          </Card>
        ))}
      </div>
    );
  };

  return (
    <div className={cn('flex items-start gap-2.5 py-2.5', isUser ? 'justify-end' : 'justify-start')}>
      {/* 机器人头像 - 仅在非用户消息时显示 */}
      {!isUser && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Bot className="h-4 w-4" />
        </div>
      )}

      {/* 消息内容 */}
      <div className={cn('max-w-[74%] xl:max-w-[70%]')}>
        <div
          className={cn(
            'rounded-[26px] px-4 py-2.5 shadow-sm',
            isUser
              ? 'bg-gradient-to-br from-primary to-blue-500 text-white'
              : 'border border-border bg-card/95'
          )}
        >
          <div className={cn(
            'prose prose-sm max-w-none leading-6',
            isUser
              ? 'dark:prose-invert prose-headings:text-white prose-p:text-white prose-strong:text-white'
              : 'dark:prose-invert prose-headings:text-foreground prose-p:text-foreground prose-strong:text-foreground dark:prose-headings:text-slate-100 dark:prose-p:text-slate-300 dark:prose-strong:text-slate-100'
          )}>
            <RichMarkdown content={message.content} />
          </div>
        </div>
        
        {/* 渲染工具输出 */}
        {isAgent && renderToolOutputs()}
      </div>

      {/* 用户头像 - 仅在用户消息时显示 */}
      {isUser && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl bg-muted text-foreground shadow-sm">
          <User className="h-4 w-4" />
        </div>
      )}
    </div>
  );
} 
