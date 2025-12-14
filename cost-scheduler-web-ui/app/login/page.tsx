'use client'

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signIn, useSession } from 'next-auth/react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Command } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const { data: session } = useSession();

  useEffect(() => {
    if (session?.user) {
      router.push('/');
    }
  }, [session, router]);

  const handleSignIn = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    try {
      await signIn("cognito", { callbackUrl: "/" });
    } catch (error) {
      console.error('Sign in error:', error);
    }
  };

  return (
    <div className="w-full lg:grid lg:min-h-screen lg:grid-cols-2">
      {/* Left Column: Cover Image & Branding */}
      <div className="relative hidden h-full flex-col bg-muted p-10 text-white dark:border-r lg:flex">
        <div className="absolute inset-0 bg-zinc-900">
             <Image
                src="/login-bg-black.png"
                alt="Login Background"
                fill
                className="object-cover opacity-80 mix-blend-overlay"
                priority
              />
        </div>
        <div className="relative z-20 flex items-center text-lg font-medium">
          <Command className="mr-2 h-6 w-6" />
          Nucleus Platform
        </div>
        <div className="relative z-20 mt-auto">
          <blockquote className="space-y-2">
            <p className="text-lg">
              &ldquo;Optimize your cloud costs efficiently with our automated scheduling and management platform.&rdquo;
            </p>
            <footer className="text-sm">Nucleus Platform</footer>
          </blockquote>
        </div>
      </div>

      {/* Right Column: Login Form */}
      <div className="flex items-center justify-center py-12">
        <div className="mx-auto grid w-[350px] gap-6">
          <div className="grid gap-2 text-center">
            <h1 className="text-3xl font-bold">Login</h1>
            <p className="text-balance text-muted-foreground">
              Sign in to your account to continue
            </p>
          </div>
          <div className="grid gap-4">
            <Button onClick={handleSignIn} variant="outline" className="w-full">
              Sign in with Cognito
            </Button>
            {/* 
              Additional login options or form fields would go here.
              For now, we strictly use Cognito OAuth redirect.
            */}
          </div>
          <div className="mt-4 text-center text-sm">
            Need help?{" "}
            <a href="#" className="underline">
              Contact Support
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
