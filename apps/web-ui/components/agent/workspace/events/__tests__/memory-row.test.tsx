// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRow } from '../memory-row';
import type { TranscriptEvent } from '@/lib/agent-chat/events';

type MemoryEvent = Extract<TranscriptEvent, { kind: 'memory' }>;

function makeEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    kind: 'memory',
    id: 'm1',
    op: 'recall',
    summary: 'Recalled that the prod DB is in us-east-1',
    count: null,
    ...overrides,
  };
}

describe('MemoryRow', () => {
  it('renders "Recalled 1 memory" for op recall, count 1', () => {
    render(<MemoryRow event={makeEvent({ op: 'recall', count: 1 })} />);
    expect(screen.getByText('Recalled 1 memory')).toBeTruthy();
  });

  it('renders "Recalled 3 memories" for op recall, count 3', () => {
    render(<MemoryRow event={makeEvent({ op: 'recall', count: 3 })} />);
    expect(screen.getByText('Recalled 3 memories')).toBeTruthy();
  });

  it('renders "Recalled memories" for op recall, count null', () => {
    render(<MemoryRow event={makeEvent({ op: 'recall', count: null })} />);
    expect(screen.getByText('Recalled memories')).toBeTruthy();
  });

  it('renders "Saved 1 memory" for op save, count 1', () => {
    render(<MemoryRow event={makeEvent({ op: 'save', count: 1 })} />);
    expect(screen.getByText('Saved 1 memory')).toBeTruthy();
  });

  it('renders "Saved 2 memories" for op save, count 2', () => {
    render(<MemoryRow event={makeEvent({ op: 'save', count: 2 })} />);
    expect(screen.getByText('Saved 2 memories')).toBeTruthy();
  });

  it('renders "Saved memories" for op save, count null', () => {
    render(<MemoryRow event={makeEvent({ op: 'save', count: null })} />);
    expect(screen.getByText('Saved memories')).toBeTruthy();
  });

  it('is collapsed by default and shows summary markdown after expanding', () => {
    const event = makeEvent({ op: 'recall', count: 2, summary: 'Hidden memory summary' });
    render(<MemoryRow event={event} />);
    expect(screen.queryByText('Hidden memory summary')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Recalled 2 memories' }));
    expect(screen.getByText('Hidden memory summary')).toBeTruthy();
  });
});
