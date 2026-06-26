/**
 * Shared shell for auth pages (login, signup, create-org). Route group — does
 * NOT affect URLs (/login, /signup, /create-org stay the same). Centers a
 * narrow column on a muted background; each page renders its own logo badge +
 * Card inside.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
            <div className="flex w-full max-w-sm flex-col gap-6">{children}</div>
        </div>
    );
}
