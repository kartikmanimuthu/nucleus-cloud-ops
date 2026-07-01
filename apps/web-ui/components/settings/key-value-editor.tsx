'use client';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Plus, X } from 'lucide-react';

interface Pair { key: string; value: string; }

interface KeyValueEditorProps {
  label: string;
  value: Pair[];
  onChange: (pairs: Pair[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export function KeyValueEditor({ label, value, onChange, keyPlaceholder = 'KEY', valuePlaceholder = 'value' }: KeyValueEditorProps) {
  const update = (i: number, patch: Partial<Pair>) => {
    onChange(value.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  };
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const add = () => onChange([...value, { key: '', value: '' }]);

  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="space-y-2">
        {value.map((pair, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input className="h-8 text-xs font-mono" value={pair.key} placeholder={keyPlaceholder} onChange={(e) => update(i, { key: e.target.value })} />
            <Input className="h-8 text-xs font-mono" value={pair.value} placeholder={valuePlaceholder} onChange={(e) => update(i, { value: e.target.value })} />
            <Button type="button" size="icon" variant="ghost" className="h-8 w-8 flex-shrink-0" onClick={() => remove(i)} aria-label="Remove">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={add}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
    </div>
  );
}
