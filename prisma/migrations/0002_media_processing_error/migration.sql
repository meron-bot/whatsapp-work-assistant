-- Capture why media (e.g. voice) processing degraded, for diagnosis via /admin/media.
ALTER TABLE "MediaAsset" ADD COLUMN "processingError" TEXT;
