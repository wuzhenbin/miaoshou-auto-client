ALTER TABLE published_oss_cleanup_schedule
    ADD COLUMN enabled boolean NOT NULL DEFAULT true;
