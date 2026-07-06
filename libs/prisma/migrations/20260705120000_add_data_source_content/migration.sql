-- Add editable document body column
ALTER TABLE "data_sources" ADD COLUMN "content" TEXT;

-- Allow the new 'document' source type
ALTER TABLE "data_sources" DROP CONSTRAINT "data_sources_source_type_check";
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_source_type_check"
    CHECK ("sourceType" IN ('file-upload', 's3-bucket', 'confluence', 'bitbucket', 'document'));
