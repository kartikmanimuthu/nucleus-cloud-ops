-- Fix accounts that were synced successfully but have connectionStatus='success' instead of 'connected'
UPDATE accounts SET "connectionStatus" = 'connected' WHERE "connectionStatus" = 'success';
