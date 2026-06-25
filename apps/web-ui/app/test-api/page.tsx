"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function TestAPIPage() {
  const [response, setResponse] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const testAuditLogs = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/audit?limit=5');
      const data = await res.json();
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  };

  const testAuditStats = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/audit/stats');
      const data = await res.json();
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  };

  const testSchedules = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/schedules');
      const data = await res.json();
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container py-8 space-y-6">
      <h1 className="text-3xl font-bold">API Test Page</h1>
      
      <div className="flex gap-4">
        <Button onClick={testAuditLogs} disabled={loading}>
          Test Audit Logs
        </Button>
        <Button onClick={testAuditStats} disabled={loading}>
          Test Audit Stats
        </Button>
        <Button onClick={testSchedules} disabled={loading}>
          Test Schedules
        </Button>
      </div>

      {loading && <p>Loading...</p>}
      
      {error && (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p>{error}</p>
          </CardContent>
        </Card>
      )}

      {response && (
        <Card>
          <CardHeader>
            <CardTitle>Response</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted p-4 rounded-md overflow-auto max-h-96">
              {JSON.stringify(response, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
