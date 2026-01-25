'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2, Shield, Users, RefreshCw } from 'lucide-react';
import { ROLE_DEFINITIONS, TenantRole } from '@/lib/rbac/types';

interface User {
  id: string;
  sub: string;
  email: string;
  name: string;
  status: string;
  enabled: boolean;
  createdAt: string;
  role: TenantRole | null;
  tenantId: string;
}

export default function UserManagementPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [assigningRole, setAssigningRole] = useState<string | null>(null);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/users');
      if (!response.ok) {
        throw new Error('Failed to fetch users');
      }
      const data = await response.json();
      setUsers(data.users);
    } catch (error) {
      toast.error('Failed to load users');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const assignRole = async (user: User, role: TenantRole) => {
    setAssigningRole(user.sub);
    try {
      const response = await fetch('/api/admin/users/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.sub,
          email: user.email,
          role,
          tenantId: user.tenantId,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to assign role');
      }

      // Update local state
      setUsers(prev => prev.map(u => 
        u.sub === user.sub ? { ...u, role } : u
      ));

      toast.success(`Role "${role}" assigned to ${user.email}`);
    } catch (error) {
      toast.error('Failed to assign role');
      console.error(error);
    } finally {
      setAssigningRole(null);
    }
  };

  const getRoleBadgeVariant = (role: TenantRole | null) => {
    switch (role) {
      case 'TenantAdmin':
        return 'default';
      case 'TenantOperator':
        return 'secondary';
      case 'TenantViewer':
        return 'outline';
      default:
        return 'destructive';
    }
  };

  const getStatusBadge = (status: string, enabled: boolean) => {
    if (!enabled) {
      return <Badge variant="destructive">Disabled</Badge>;
    }
    switch (status) {
      case 'CONFIRMED':
        return <Badge variant="default">Active</Badge>;
      case 'UNCONFIRMED':
        return <Badge variant="secondary">Pending</Badge>;
      case 'FORCE_CHANGE_PASSWORD':
        return <Badge variant="outline">Password Reset</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="container mx-auto p-6 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Shield className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-3xl font-bold">User Management</h1>
            <p className="text-muted-foreground">Manage user roles and permissions</p>
          </div>
        </div>
        <Button onClick={fetchUsers} variant="outline" disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Role Legend */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="h-5 w-5" />
            Role Definitions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {ROLE_DEFINITIONS.map(role => (
              <div key={role.id} className="p-3 rounded-lg border">
                <div className="font-medium">{role.name}</div>
                <div className="text-sm text-muted-foreground mb-2">{role.description}</div>
                <div className="flex flex-wrap gap-1">
                  {role.permissions.map(perm => (
                    <Badge key={perm} variant="secondary" className="text-xs">
                      {perm}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Users Table */}
      <Card>
        <CardHeader>
          <CardTitle>Users ({users.length})</CardTitle>
          <CardDescription>
            Cognito users and their assigned roles
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : users.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No users found
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Current Role</TableHead>
                  <TableHead>Assign Role</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map(user => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div>
                        <div className="font-medium">{user.name || user.email}</div>
                        <div className="text-sm text-muted-foreground">{user.email}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {getStatusBadge(user.status, user.enabled)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={getRoleBadgeVariant(user.role)}>
                        {user.role || 'No Role'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={user.role || ''}
                        onValueChange={(value) => assignRole(user, value as TenantRole)}
                        disabled={assigningRole === user.sub}
                      >
                        <SelectTrigger className="w-40">
                          {assigningRole === user.sub ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <SelectValue placeholder="Select role" />
                          )}
                        </SelectTrigger>
                        <SelectContent>
                          {ROLE_DEFINITIONS.map(role => (
                            <SelectItem key={role.id} value={role.id}>
                              {role.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
