-- Add errors column to inventory_sync_status for recording scan errors
ALTER TABLE "inventory_sync_status" ADD COLUMN "errors" TEXT[];
