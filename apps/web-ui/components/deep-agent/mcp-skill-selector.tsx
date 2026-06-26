'use client';

import React, { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Server, BookOpen, ChevronDown, Check, Zap } from 'lucide-react';

interface SkillMeta {
  id: string;
  name: string;
  description: string;
}

interface McpServer {
  id: string;
  name: string;
}

interface McpSkillSelectorProps {
  selectedSkills: string[];
  onSkillsChange: (skills: string[]) => void;
  selectedMcpServers: string[];
  onMcpServersChange: (servers: string[]) => void;
}

export function McpSkillSelector({
  selectedSkills,
  onSkillsChange,
  selectedMcpServers,
  onMcpServersChange,
}: McpSkillSelectorProps) {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [showSkills, setShowSkills] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const skillsRef = useRef<HTMLDivElement>(null);
  const mcpRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/skills')
      .then(r => r.json())
      .then(data => setSkills(data.skills ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/mcp-servers')
      .then(r => r.json())
      .then(data => setMcpServers(data.servers ?? []))
      .catch(() => {});
  }, []);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (skillsRef.current && !skillsRef.current.contains(e.target as Node)) setShowSkills(false);
      if (mcpRef.current && !mcpRef.current.contains(e.target as Node)) setShowMcp(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function toggleSkill(id: string) {
    onSkillsChange(
      selectedSkills.includes(id)
        ? selectedSkills.filter(s => s !== id)
        : [...selectedSkills, id],
    );
  }

  function toggleMcp(id: string) {
    onMcpServersChange(
      selectedMcpServers.includes(id)
        ? selectedMcpServers.filter(s => s !== id)
        : [...selectedMcpServers, id],
    );
  }

  const skillLabel = selectedSkills.length === 0
    ? 'Auto Skills'
    : `${selectedSkills.length} skill${selectedSkills.length > 1 ? 's' : ''}`;

  const mcpLabel = selectedMcpServers.length === 0
    ? 'No MCP'
    : `${selectedMcpServers.length} MCP`;

  return (
    <div className="flex items-center gap-2">
      {/* Skills dropdown */}
      <div className="relative" ref={skillsRef}>
        <button
          onClick={() => { setShowSkills(v => !v); setShowMcp(false); }}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-all',
            selectedSkills.length > 0
              ? 'bg-violet-500/10 text-violet-600 dark:text-violet-300 border-violet-500/25'
              : 'bg-muted text-muted-foreground border-border hover:border-border/80 hover:text-foreground',
          )}
        >
          <Zap className="w-3 h-3" />
          {skillLabel}
          <ChevronDown className={cn('w-3 h-3 transition-transform', showSkills && 'rotate-180')} />
        </button>

        {showSkills && (
          <div className="absolute bottom-full mb-2 left-0 w-64 bg-popover border border-border rounded-xl shadow-xl overflow-hidden z-50">
            <div className="px-3 py-2.5 border-b border-border bg-muted/50">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">Skills</span>
                <button
                  onClick={() => onSkillsChange([])}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  Auto-load all
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {selectedSkills.length === 0
                  ? 'All available skills will be auto-loaded'
                  : `${selectedSkills.length} selected`}
              </p>
            </div>
            <div className="max-h-52 overflow-y-auto p-1.5 space-y-0.5">
              {skills.length === 0 ? (
                <p className="text-xs text-muted-foreground px-2 py-2">No skills found</p>
              ) : (
                skills.map(skill => (
                  <button
                    key={skill.id}
                    onClick={() => toggleSkill(skill.id)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors',
                      selectedSkills.includes(skill.id)
                        ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
                        : 'hover:bg-accent text-foreground',
                    )}
                  >
                    <div className={cn(
                      'w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0',
                      selectedSkills.includes(skill.id)
                        ? 'bg-violet-500 border-violet-500'
                        : 'border-border',
                    )}>
                      {selectedSkills.includes(skill.id) && (
                        <Check className="w-2.5 h-2.5 text-white" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{skill.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{skill.description}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
            <div className="px-3 py-2 border-t border-border bg-muted/30">
              <button
                onClick={() => setShowSkills(false)}
                className="w-full py-1.5 rounded-lg bg-muted text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>

      {/* MCP Servers dropdown */}
      <div className="relative" ref={mcpRef}>
        <button
          onClick={() => { setShowMcp(v => !v); setShowSkills(false); }}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-all',
            selectedMcpServers.length > 0
              ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-300 border-cyan-500/25'
              : 'bg-muted text-muted-foreground border-border hover:border-border/80 hover:text-foreground',
          )}
        >
          <Server className="w-3 h-3" />
          {mcpLabel}
          <ChevronDown className={cn('w-3 h-3 transition-transform', showMcp && 'rotate-180')} />
        </button>

        {showMcp && (
          <div className="absolute bottom-full mb-2 left-0 w-64 bg-popover border border-border rounded-xl shadow-xl overflow-hidden z-50">
            <div className="px-3 py-2.5 border-b border-border bg-muted/50">
              <span className="text-xs font-semibold text-foreground">MCP Servers</span>
              {selectedMcpServers.length > 0 && (
                <p className="text-[10px] text-muted-foreground mt-0.5">{selectedMcpServers.length} selected</p>
              )}
            </div>
            <div className="max-h-52 overflow-y-auto p-1.5 space-y-0.5">
              {mcpServers.length === 0 ? (
                <p className="text-xs text-muted-foreground px-2 py-2">No MCP servers configured</p>
              ) : (
                mcpServers.map(server => (
                  <button
                    key={server.id}
                    onClick={() => toggleMcp(server.id)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors',
                      selectedMcpServers.includes(server.id)
                        ? 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300'
                        : 'hover:bg-accent text-foreground',
                    )}
                  >
                    <div className={cn(
                      'w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0',
                      selectedMcpServers.includes(server.id)
                        ? 'bg-cyan-500 border-cyan-500'
                        : 'border-border',
                    )}>
                      {selectedMcpServers.includes(server.id) && (
                        <Check className="w-2.5 h-2.5 text-white" />
                      )}
                    </div>
                    <span className="text-xs truncate">{server.name || server.id}</span>
                  </button>
                ))
              )}
            </div>
            <div className="px-3 py-2 border-t border-border bg-muted/30">
              <button
                onClick={() => setShowMcp(false)}
                className="w-full py-1.5 rounded-lg bg-muted text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
