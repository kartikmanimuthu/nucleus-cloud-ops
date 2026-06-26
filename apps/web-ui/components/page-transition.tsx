'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { usePathname } from 'next/navigation';

/**
 * Subtle enter transition on route change. Keyed by pathname so the content
 * re-mounts and fades/slides in whenever the route changes. No exit animation
 * (App Router swaps children without unmount choreography), which keeps this
 * robust and jank-free. Respects prefers-reduced-motion.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const reduce = useReducedMotion();

    return (
        <motion.div
            key={pathname}
            initial={{ opacity: 0, y: reduce ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            className="min-w-0"
        >
            {children}
        </motion.div>
    );
}
