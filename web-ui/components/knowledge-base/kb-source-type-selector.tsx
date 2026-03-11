'use client';

import { Database, FileUp, GitBranch, Globe } from 'lucide-react';
import type { DataSourceType } from '@/lib/knowledge-base/types';

interface SourceTypeOption {
  type: DataSourceType;
  icon: React.ElementType;
  title: string;
  description: string;
}

const SOURCE_TYPE_OPTIONS: SourceTypeOption[] = [
  {
    type: 'file-upload',
    icon: FileUp,
    title: 'File Upload',
    description: 'Upload files directly',
  },
  {
    type: 's3-bucket',
    icon: Database,
    title: 'S3 Bucket',
    description: 'Connect an S3 bucket',
  },
  {
    type: 'confluence',
    icon: Globe,
    title: 'Confluence',
    description: 'Import Confluence docs',
  },
  {
    type: 'bitbucket',
    icon: GitBranch,
    title: 'Bitbucket',
    description: 'Sync a Bitbucket repo',
  },
];

export interface KBSourceTypeSelectorProps {
  selected: DataSourceType | null;
  onSelect: (type: DataSourceType) => void;
}

export function KBSourceTypeSelector({ selected, onSelect }: KBSourceTypeSelectorProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {SOURCE_TYPE_OPTIONS.map(({ type, icon: Icon, title, description }) => {
        const isSelected = selected === type;
        return (
          <button
            key={type}
            type="button"
            onClick={() => onSelect(type)}
            className={`
              flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors
              hover:bg-muted/50
              ${isSelected
                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                : 'border-border bg-card'
              }
            `}
          >
            <div
              className={`rounded-md p-2 ${isSelected ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div>
              <p className={`text-sm font-medium ${isSelected ? 'text-primary' : ''}`}>{title}</p>
              <p className="text-xs text-muted-foreground">{description}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
