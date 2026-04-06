-- Add error tracking columns to data_sources table
-- last_error_message: user-friendly short error message for UI display
-- last_error_detail:  full error message + stack trace for debugging

ALTER TABLE "data_sources"
  ADD COLUMN IF NOT EXISTS "lastErrorMessage" TEXT,
  ADD COLUMN IF NOT EXISTS "lastErrorDetail"  TEXT;
