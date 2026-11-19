ALTER TABLE published_oss_cleanup_records DROP CONSTRAINT published_oss_cleanup_records_status_check;
ALTER TABLE published_oss_cleanup_records ADD CONSTRAINT published_oss_cleanup_records_status_check
    CHECK (status IN ('pending','succeeded','failed','skipped'));
ALTER TABLE published_oss_cleanup_runs ADD COLUMN skipped_records integer NOT NULL DEFAULT 0;
