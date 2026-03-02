'use client';

import React, { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Cloud, ChevronDown, Check } from 'lucide-react';
import { ClientAccountService } from '@/lib/client-account-service';

interface AwsAccount {
  accountId: string;
  accountName: string;
}

interface AccountSelectorProps {
  selectedAccounts: AwsAccount[];
  onAccountsChange: (accounts: AwsAccount[]) => void;
}

export function AccountSelector({
  selectedAccounts,
  onAccountsChange,
}: AccountSelectorProps) {
  const [accounts, setAccounts] = useState<AwsAccount[]>([]);
  const [showAccounts, setShowAccounts] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchAccounts() {
      try {
        setIsLoading(true);
        const { accounts: fetchedAccounts } = await ClientAccountService.getAccounts({
          statusFilter: "active",
          connectionFilter: "connected",
          limit: 1000,
        });
        setAccounts(fetchedAccounts.map((a: any) => ({
          accountId: a.accountId,
          accountName: a.name || a.accountId,
        })));
      } catch (error) {
        console.error("Failed to load accounts:", error);
      } finally {
        setIsLoading(false);
      }
    }
    fetchAccounts();
  }, []);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowAccounts(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function toggleAccount(account: AwsAccount) {
    const exists = selectedAccounts.some(a => a.accountId === account.accountId);
    if (exists) {
      onAccountsChange(selectedAccounts.filter(a => a.accountId !== account.accountId));
    } else {
      onAccountsChange([...selectedAccounts, account]);
    }
  }

  const accountLabel = selectedAccounts.length === 0
    ? 'All Accounts'
    : `${selectedAccounts.length} Account${selectedAccounts.length > 1 ? 's' : ''}`;

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setShowAccounts(v => !v)}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-all',
          selectedAccounts.length > 0
            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25'
            : 'bg-muted text-muted-foreground border-border hover:border-border/80 hover:text-foreground',
        )}
      >
        <Cloud className="w-3 h-3" />
        {accountLabel}
        <ChevronDown className={cn('w-3 h-3 transition-transform', showAccounts && 'rotate-180')} />
      </button>

      {showAccounts && (
        <div className="absolute bottom-full mb-2 left-0 w-64 bg-popover border border-border rounded-xl shadow-xl overflow-hidden z-50">
          <div className="px-3 py-2.5 border-b border-border bg-muted/50">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">AWS Accounts</span>
              <button
                onClick={() => onAccountsChange([])}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                disabled={selectedAccounts.length === 0}
              >
                Clear
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {selectedAccounts.length === 0
                ? 'All accounts available to agent'
                : `${selectedAccounts.length} selected`}
            </p>
          </div>
          
          <div className="max-h-52 overflow-y-auto p-1.5 space-y-0.5">
            {isLoading ? (
              <p className="text-xs text-muted-foreground px-2 py-2">Loading accounts...</p>
            ) : accounts.length === 0 ? (
              <p className="text-xs text-muted-foreground px-2 py-2">No AWS accounts found</p>
            ) : (
              accounts.map(acc => {
                const isSelected = selectedAccounts.some(a => a.accountId === acc.accountId);
                return (
                  <button
                    key={acc.accountId}
                    onClick={() => toggleAccount(acc)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors',
                      isSelected
                        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                        : 'hover:bg-accent text-foreground',
                    )}
                  >
                    <div className={cn(
                      'w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0',
                      isSelected
                        ? 'bg-amber-500 border-amber-500'
                        : 'border-border',
                    )}>
                      {isSelected && (
                        <Check className="w-2.5 h-2.5 text-white" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{acc.accountName}</p>
                      <p className="text-[10px] text-muted-foreground truncate font-mono">
                        {acc.accountId}
                      </p>
                    </div>
                  </button>
                );
              })
            )}
          </div>
          
          <div className="px-3 py-2 border-t border-border bg-muted/30">
            <button
              onClick={() => setShowAccounts(false)}
              className="w-full py-1.5 rounded-lg bg-muted text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
