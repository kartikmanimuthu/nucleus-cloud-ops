'use client';

import { signIn } from "next-auth/react";
import { ArrowRight } from "lucide-react";

export function SignInButton({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <button
      onClick={() => signIn("cognito", { callbackUrl: "/app/dashboard" })}
      className={className}
    >
      {children}
    </button>
  );
}
