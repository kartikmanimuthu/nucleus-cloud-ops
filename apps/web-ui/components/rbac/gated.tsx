'use client';

/**
 * Permission-gated wrappers for the two controls that need gating everywhere:
 * a button and a dropdown item.
 *
 * ── WHY THESE ARE COMPONENTS AND NOT A HOOK CALL AT THE CALL SITE ───────────
 * Conditional grants are evaluated against a ROW, so a table has to ask a
 * different question per row — and hooks cannot be called inside `.map()`,
 * because the number of calls would vary with the row count. Wrapping each
 * control in its own component gives each one its own render, so one hook call
 * per control is legal and the row can be passed in.
 *
 * ── HIDE vs DISABLE ─────────────────────────────────────────────────────────
 * DISABLE, with the reason in a tooltip. This is the project's standing
 * preference, not just a default: a control that vanishes is indistinguishable
 * from a broken page and gives the user nothing to act on, whereas an inert one
 * answers "you may not do this, and here is why". It also matters for a role
 * that holds the action on some rows and not others.
 *
 * `hideWhenDenied` remains available for the rare case where the affordance
 * itself is the secret — a whole section a role should never learn exists — but
 * do not reach for it on ordinary create/edit/delete controls.
 *
 * Either way this is UX. `authorize()` on the route is the boundary; a hidden
 * button stops nobody who can use a terminal.
 */

import { isValidElement, type ComponentProps, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useCan, useDenialReason } from '@/hooks/use-can';

interface GateProps {
    /** Verb as the code calls it — aliases are resolved against the registry. */
    action: string;
    /** CASL subject key, e.g. 'Schedule'. */
    subject: string;
    /**
     * The row this control acts on. PASS IT whenever one exists: without it a
     * conditional grant reads as permitted and the control is enabled on rows
     * the API will refuse.
     */
    data?: Record<string, unknown> | null;
    /** Render nothing instead of a disabled control. */
    hideWhenDenied?: boolean;
    children: ReactNode;
}

/**
 * Render-prop gate, for controls that are not the `Button` primitive.
 *
 * Several tables hand-roll a `<button>` with the primitive's classes inline.
 * Routing those through GatedButton would silently restyle them, so they get
 * the decision and apply it themselves.
 *
 *   <Gate action="update" subject="Account" data={account}>
 *     {({ allowed, reason }) => <button disabled={!allowed} title={reason ?? ''} />}
 *   </Gate>
 */
export function Gate({
    action,
    subject,
    data,
    hideWhenDenied,
    children,
}: Omit<GateProps, 'children'> & {
    children: (state: { allowed: boolean; reason: string | null }) => ReactNode;
}) {
    const allowed = useCan(action, subject, data);
    const reason = useDenialReason(action, subject, data);

    if (!allowed && hideWhenDenied) return null;
    return <>{children({ allowed, reason })}</>;
}

export function GatedButton({
    action,
    subject,
    data,
    hideWhenDenied,
    children,
    ...props
}: GateProps & ComponentProps<typeof Button>) {
    const allowed = useCan(action, subject, data);
    const reason = useDenialReason(action, subject, data);

    if (!allowed && hideWhenDenied) return null;

    /**
     * ── `asChild` + DENIED IS A TRAP ────────────────────────────────────────
     * With `asChild`, Radix's Slot forwards these props onto the child — almost
     * always a next/link `<Link>`. An anchor has NO `disabled` attribute, so the
     * browser silently drops it: the control renders at full opacity and stays
     * clickable, and the only sign anything was denied is the 403 that comes back
     * from the API. The gate computed the right answer and nothing acted on it.
     *
     * So a denied `asChild` button is rebuilt as a real <button>. `asChild` is
     * forced off and one level of the child is unwrapped, which drops the <Link>
     * and keeps its contents — there is then no anchor left to navigate.
     */
    if (!allowed && props.asChild) {
        const { asChild: _asChild, ...rest } = props;
        const inner = isValidElement<{ children?: ReactNode }>(children)
            ? children.props.children
            : children;

        return (
            <span className="inline-flex cursor-not-allowed" title={reason ?? undefined} aria-disabled="true">
                <Button {...rest} asChild={false} disabled title={undefined}>
                    {inner}
                </Button>
            </span>
        );
    }

    const button = (
        <Button {...props} disabled={props.disabled || !allowed} title={allowed ? props.title : undefined}>
            {children}
        </Button>
    );

    if (allowed) return button;

    /**
     * ── WHY THE WRAPPER ────────────────────────────────────────────────────
     * The Button primitive carries `disabled:pointer-events-none`. A disabled
     * element with no pointer events receives no hover at all, so BOTH the
     * not-allowed cursor and the native `title` tooltip were silently dropped —
     * the denial reason this component computes was never actually reachable.
     *
     * The span sits outside the button and does receive pointer events, so it
     * can own the cursor and the tooltip. The button itself stays genuinely
     * disabled: re-enabling pointer events on it would make a denied control
     * clickable again, which is the one thing this must never do.
     *
     * `aria-disabled` on the wrapper keeps the reason available to assistive
     * tech, which cannot read a CSS cursor.
     */
    return (
        <span
            className="inline-flex cursor-not-allowed"
            title={reason ?? undefined}
            aria-disabled="true"
        >
            {button}
        </span>
    );
}

export function GatedDropdownItem({
    action,
    subject,
    data,
    hideWhenDenied,
    children,
    ...props
}: GateProps & ComponentProps<typeof DropdownMenuItem>) {
    const allowed = useCan(action, subject, data);
    const reason = useDenialReason(action, subject, data);

    if (!allowed && hideWhenDenied) return null;

    /**
     * Not wrapped in a span like GatedButton: Radix menus expect their items as
     * direct children for roving focus and typeahead, and an extra element
     * breaks keyboard navigation.
     *
     * `data-[disabled]:pointer-events-none` on the primitive still suppresses
     * hover, so the cursor and tooltip only appear where a caller overrides it.
     * The class is applied regardless so the intent survives, and the reason
     * stays reachable through aria-disabled either way. Menu items are also a
     * milder case than page buttons: the item is visibly dimmed and unselectable.
     */
    const deniedClass = allowed ? '' : 'cursor-not-allowed';

    return (
        <DropdownMenuItem
            {...props}
            className={[props.className, deniedClass].filter(Boolean).join(' ') || undefined}
            disabled={props.disabled || !allowed}
            aria-disabled={!allowed || undefined}
            title={allowed ? props.title : (reason ?? undefined)}
            // A disabled item must not fire even if a click lands on it — Radix
            // stops pointer events, but onSelect can still be reached by
            // keyboard in some versions, and this action is destructive.
            onClick={allowed ? props.onClick : undefined}
            onSelect={allowed ? props.onSelect : (e) => e.preventDefault()}
        >
            {children}
        </DropdownMenuItem>
    );
}
