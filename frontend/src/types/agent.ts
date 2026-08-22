export type AgentEventType =
  | 'goal'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'answer'
  | 'status'
  | 'error';

export interface AgentRunEvent {
  id: string;
  type: AgentEventType;
  title: string;
  detail?: string;
  status?: 'pending' | 'running' | 'done' | 'error';
  createdAt: string;
}

export interface AgentToolInvocation {
  id: string;
  toolName: string;
  status: 'pending' | 'running' | 'done' | 'error';
  argsText?: string;
  resultText?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentArtifact {
  id: string;
  kind: 'summary' | 'tool_output' | 'symbol';
  title: string;
  content: string;
  createdAt: string;
}
