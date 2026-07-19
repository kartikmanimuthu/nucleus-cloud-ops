// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThinkingBlock } from '../thinking-block';
import type { TranscriptEvent } from '@/lib/agent-chat/events';

type ThinkingEvent = Extract<TranscriptEvent, { kind: 'thinking' }>;

function makeEvent(overrides: Partial<ThinkingEvent> = {}): ThinkingEvent {
  return {
    kind: 'thinking',
    id: 'e1',
    phase: 'execution',
    text: 'Considering the next step...',
    streaming: false,
    ...overrides,
  };
}

describe('ThinkingBlock', () => {
  it('renders "Thought for 12s" when durationMs is known', () => {
    render(<ThinkingBlock event={makeEvent()} durationMs={12000} />);
    expect(screen.getByText('Thought for 12s')).toBeTruthy();
  });

  it('renders "Thinking…" while streaming and no durationMs', () => {
    render(<ThinkingBlock event={makeEvent({ streaming: true })} />);
    expect(screen.getByText('Thinking…')).toBeTruthy();
  });

  it('renders "Thought" when not streaming and no durationMs', () => {
    render(<ThinkingBlock event={makeEvent({ streaming: false })} />);
    expect(screen.getByText('Thought')).toBeTruthy();
  });

  it('hides content when collapsed, shows after expanding', () => {
    const event = makeEvent({ text: 'Hidden reasoning text' });
    render(<ThinkingBlock event={event} />);
    expect(screen.queryByText('Hidden reasoning text')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Thought' }));
    expect(screen.getByText('Hidden reasoning text')).toBeTruthy();
  });

  it('shows "Reflection" phase chip when expanded for phase reflection', () => {
    const event = makeEvent({ phase: 'reflection', text: 'Reflecting on results' });
    render(<ThinkingBlock event={event} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thought' }));
    expect(screen.getByText('Reflection')).toBeTruthy();
  });

  it('shows no phase chip for phase execution', () => {
    const event = makeEvent({ phase: 'execution', text: 'Running the command' });
    render(<ThinkingBlock event={event} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thought' }));
    expect(screen.queryByText('Execution')).toBeNull();
  });

  it('auto-collapses when streaming flips from true to false', () => {
    const event = makeEvent({ streaming: true, text: 'Streaming reasoning' });
    const { rerender } = render(<ThinkingBlock event={event} />);
    expect(screen.getByText('Streaming reasoning')).toBeTruthy();
    rerender(<ThinkingBlock event={{ ...event, streaming: false }} />);
    expect(screen.queryByText('Streaming reasoning')).toBeNull();
  });

  it('renders exactly one "thinking"-ish element while streaming — no duplicate badge from the underlying primitive', () => {
    render(<ThinkingBlock event={makeEvent({ streaming: true })} />);
    expect(screen.getAllByText(/thinking/i)).toHaveLength(1);
  });
});
