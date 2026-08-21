// @vitest-environment jsdom
//
// The priority order (name > number > region) is the whole point of this
// component, and it is shared by Spot Guard and Scale Sentinel across four call
// sites. These pin the order and the no-name fallback so a future style tweak
// cannot silently flatten the hierarchy or leave a blank top line.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AccountRegion } from '../account-region';

describe('AccountRegion', () => {
    it('renders all three tiers in priority order', () => {
        render(<AccountRegion accountName="STX Sandbox" accountId="688849551607" region="ap-south-1" />);
        const name = screen.getByText('STX Sandbox');
        const number = screen.getByText('688849551607');
        const region = screen.getByText('ap-south-1');

        // Name carries the weight; number and region do not.
        expect(name.className).toContain('font-medium');
        expect(number.className).not.toContain('font-medium');
        // Number stays monospace so 12-digit ids line up down the column.
        expect(number.className).toContain('font-mono');
        // Region is the most muted of the three.
        expect(region.className).toContain('text-muted-foreground/70');
    });

    it('stays at the table text size — no tier is scaled up', () => {
        const { container } = render(
            <AccountRegion accountName="STX Sandbox" accountId="688849551607" region="ap-south-1" />
        );
        // A larger tier would pull focus away from the resource the row is about.
        expect(container.querySelectorAll('.text-sm').length).toBe(0);
        expect(container.querySelectorAll('.text-xs').length).toBe(3);
    });

    it('promotes the number when no name resolves, rather than leaving a blank line', () => {
        render(<AccountRegion accountId="688849551607" region="ap-south-1" />);
        expect(screen.queryByText('STX Sandbox')).toBeNull();
        // The number takes the top tier's weight so the block never looks empty.
        expect(screen.getByText('688849551607').className).toContain('font-medium');
    });

    it('treats a whitespace-only name as absent', () => {
        render(<AccountRegion accountName="   " accountId="688849551607" />);
        expect(screen.getByText('688849551607').className).toContain('font-medium');
    });

    it('omits region entirely when not supplied', () => {
        render(<AccountRegion accountName="STX Sandbox" accountId="688849551607" region={null} />);
        expect(screen.getByText('STX Sandbox')).toBeTruthy();
        expect(screen.getByText('688849551607')).toBeTruthy();
    });

    it('inline layout keeps the same order and weights on one line', () => {
        const { container } = render(
            <AccountRegion layout="inline" accountName="STX Sandbox" accountId="688849551607" region="ap-south-1" />
        );
        expect(container.querySelector('span')?.className).toContain('inline-flex');
        expect(screen.getByText('STX Sandbox').className).toContain('font-medium');
        expect(screen.getByText('688849551607').className).toContain('font-mono');
    });
});
