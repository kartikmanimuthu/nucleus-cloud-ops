"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { CreateAccountForm } from "./create-account-form";

export interface CreateAccountViewProps {
  hubAccountId: string;
}

export default function CreateAccountView({ hubAccountId }: CreateAccountViewProps) {
  const router = useRouter();

  return (
    <div className="container mx-auto py-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center space-x-4">
          <Button variant="outline" onClick={() => router.back()}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Create AWS Account</h1>
            <p className="text-muted-foreground">
              Add a new AWS account to the Nucleus Ops Platform
            </p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account Configuration</CardTitle>
          <CardDescription>
            Configure the AWS account settings and cross-account role
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateAccountForm hubAccountId={hubAccountId} />
        </CardContent>
      </Card>
    </div>
  );
}
