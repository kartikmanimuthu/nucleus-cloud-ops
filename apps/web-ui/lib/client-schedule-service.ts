// Client-safe schedule service that uses API routes instead of direct AWS SDK calls
import { UISchedule, Schedule } from './types';

export class ClientScheduleService {
    private static baseUrl = '/api/schedules';

    /**
     * Fetch all schedules via API route
     */
    static async getSchedules(filters?: {
        statusFilter?: string;
        resourceFilter?: string;
        searchTerm?: string;
        page?: number;
        limit?: number;
    }): Promise<{ schedules: UISchedule[], total: number }> {
        try {
            console.log('ClientScheduleService - Fetching schedules via API route', filters);

            // Build query parameters
            const params = new URLSearchParams();
            if (filters?.statusFilter) {
                params.append('status', filters.statusFilter);
            }
            if (filters?.resourceFilter) {
                params.append('resource', filters.resourceFilter);
            }
            if (filters?.searchTerm) {
                params.append('search', filters.searchTerm);
            }
            if (filters?.page) {
                params.append('page', filters.page.toString());
            }
            if (filters?.limit) {
                params.append('limit', filters.limit.toString());
            }

            const url = params.toString() ? `${this.baseUrl}?${params.toString()}` : this.baseUrl;
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
                cache: 'no-store',
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            if (!result.success) {
                throw new Error(result.error || 'Failed to fetch schedules');
            }

            console.log('ClientScheduleService - Successfully fetched schedules:', result.data.length);
            return {
                schedules: result.data,
                total: result.meta?.total || result.data.length
            };
        } catch (error) {
            console.error('ClientScheduleService - Error fetching schedules:', error);
            throw error;
        }
    }

    /**
     * Get a specific schedule by ID via API route
     */
    static async getSchedule(id: string): Promise<UISchedule | null> {
        try {
            console.log('ClientScheduleService - Fetching schedule:', id);
            const response = await fetch(`${this.baseUrl}/${encodeURIComponent(id)}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
                cache: 'no-store',
            });

            const result = await response.json();

            if (response.status === 404) {
                return null;
            }

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            // Note: API might return object directly or wrapped in success/data.
            // Our updated routes return object directly or {error}.
            // Previous code handled success: true wrapped.
            // Let's check updated route return type from previous diffs.
            // Updated route returns `NextResponse.json(schedule)` directly.

            return result as UISchedule;
        } catch (error) {
            console.error('ClientScheduleService - Error fetching schedule:', error);
            throw error;
        }
    }

    /**
     * Create a new schedule via API route
     */
    static async createSchedule(schedule: Omit<Schedule, 'id' | 'type'>): Promise<Schedule> {
        // Create remains same, but maybe returns object directly?
        try {
            console.log('ClientScheduleService - Creating schedule:', schedule.name);
            const response = await fetch(this.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(schedule),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            // Route handler returns { success: true, data: ... }.
            // Wait, I didn't update CREATE/POST route.
            // Assuming CREATE route is in app/api/schedules/route.ts (root).
            // Usually CREATE returns the created object.

            // Previous code expected:
            // if (!result.success) throw...
            // return result.data;

            // I should respect existing contract if I haven't changed CREATE route.
            // I haven't changed CREATE route (it's in parent dir likely).

            if (result.success !== undefined && !result.success) {
                throw new Error(result.error || 'Failed to create schedule');
            }
            return result.data || result;
        } catch (error) {
            console.error('ClientScheduleService - Error creating schedule:', error);
            throw error;
        }
    }

    /**
     * Update an existing schedule via API route
     */
    static async updateSchedule(
        scheduleId: string,
        updates: Partial<Omit<Schedule, 'name' | 'type'>>
    ): Promise<UISchedule> {
        try {
            console.log('ClientScheduleService - Updating schedule:', scheduleId);
            const response = await fetch(`${this.baseUrl}/${encodeURIComponent(scheduleId)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(updates),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            // Updated route returns `updatedSchedule` directly.
            // So we return result.
            return result as UISchedule;
        } catch (error) {
            console.error('ClientScheduleService - Error updating schedule:', error);
            throw error;
        }
    }

    /**
     * Delete a schedule via API route
     */
    static async deleteSchedule(id: string): Promise<void> {
        try {
            console.log('ClientScheduleService - Deleting schedule:', id);
            const response = await fetch(`${this.baseUrl}/${encodeURIComponent(id)}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            // Updated route returns { success: true }.
        } catch (error) {
            console.error('ClientScheduleService - Error deleting schedule:', error);
            throw error;
        }
    }

    /**
     * Toggle schedule active status via API route
     */
    static async toggleScheduleStatus(id: string): Promise<UISchedule> {
        try {
            console.log('ClientScheduleService - Toggling schedule status:', id);
            const response = await fetch(`${this.baseUrl}/${encodeURIComponent(id)}/toggle`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            if (result.success !== undefined && !result.success) {
                throw new Error(result.error || 'Failed to toggle schedule status');
            }

            console.log('ClientScheduleService - Successfully toggled schedule status:', id);
            return result.data || result;
        } catch (error) {
            console.error('ClientScheduleService - Error toggling schedule status:', error);
            throw error;
        }
    }
}
