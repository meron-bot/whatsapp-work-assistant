-- Link an open loop back to the approval/clarification that owns it, so the loop
-- can be closed when that approval is decided or the clarification is answered/
-- expired. Without these links the waiting_for_owner loops never closed and the
-- follow-up watcher re-nudged them forever.
ALTER TABLE "OpenLoop" ADD COLUMN "linkedApprovalId" TEXT;
ALTER TABLE "OpenLoop" ADD COLUMN "linkedClarificationId" TEXT;
