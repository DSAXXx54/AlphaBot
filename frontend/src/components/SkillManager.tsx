'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Bot, RefreshCw } from 'lucide-react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { listAdminSkills, refreshAdminSkills, updateAdminSkillStatus } from '@/lib/api';
import { AgentSkillInfo } from '@/types/user';
import { Button } from './ui/button';
import { Switch } from './ui/switch';

export default function SkillManager() {
  const { user } = useAuth();
  const [skills, setSkills] = useState<AgentSkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [updatingSkill, setUpdatingSkill] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadSkills = useCallback(async (mode: 'load' | 'refresh' = 'load') => {
    if (mode === 'refresh') {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    setMessage(null);
    try {
      const response = mode === 'refresh' ? await refreshAdminSkills() : await listAdminSkills();
      if (!response.success || !response.data) {
        throw new Error(response.error || '获取 Skill 列表失败');
      }
      setSkills(response.data);
      if (mode === 'refresh') {
        setMessage('技能列表已刷新');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取 Skill 列表失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const handleToggle = useCallback(async (skillName: string, enabled: boolean) => {
    setUpdatingSkill(skillName);
    setError(null);
    setMessage(null);
    try {
      const response = await updateAdminSkillStatus(skillName, enabled);
      if (!response.success || !response.data) {
        throw new Error(response.error || '更新 Skill 状态失败');
      }
      setSkills((prev) => prev.map((item) => (item.name === skillName ? response.data! : item)));
      setMessage(`${response.data.label} 已${enabled ? '启用' : '禁用'}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新 Skill 状态失败');
    } finally {
      setUpdatingSkill(null);
    }
  }, []);

  useEffect(() => {
    if (user?.is_admin) {
      void loadSkills();
    }
  }, [loadSkills, user?.is_admin]);

  if (!user?.is_admin) {
    return (
      <div className="py-8 text-center">
        <p className="text-muted-foreground">只有管理员可以查看技能管理</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Bot className="h-5 w-5 text-slate-500" />
            <h2 className="text-xl font-semibold text-slate-900 dark:text-white">技能管理</h2>
          </div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            展示 builtin Skill 与 `data/skills` 下的 custom Skill；只有 custom Skill 可控制是否允许在自动化与 Agent 中使用。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void loadSkills('refresh')} disabled={refreshing || loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          刷新技能
        </Button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}
      {message && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
          {message}
        </div>
      )}

      <div className="mt-6 space-y-3">
        {skills.length === 0 && !loading ? (
          <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
            当前没有发现 Skill
          </div>
        ) : (
          skills.map((skill) => {
            const isPending = updatingSkill === skill.name;
            const isBuiltin = skill.kind === 'builtin';
            return (
              <div key={skill.name} className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-base font-semibold text-slate-900 dark:text-white">{skill.label}</div>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {skill.name}
                      </span>
                      <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">
                        {isBuiltin ? 'builtin' : 'custom'}
                      </span>
                      <span className={`rounded-full px-2.5 py-1 text-[11px] ${skill.enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}>
                        {skill.enabled ? '已启用' : '已禁用'}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{skill.description}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {skill.manageable === false ? (
                      <span className="text-sm text-slate-500 dark:text-slate-400">builtin Skill 不可禁用</span>
                    ) : (
                      <>
                        <span className="text-sm text-slate-500 dark:text-slate-400">{skill.enabled ? '启用中' : '已关闭'}</span>
                        <Switch
                          checked={skill.enabled}
                          disabled={isPending}
                          onCheckedChange={(checked) => void handleToggle(skill.name, checked)}
                          aria-label={`切换 ${skill.label} 状态`}
                        />
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
