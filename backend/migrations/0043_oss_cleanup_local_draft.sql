ALTER TABLE published_oss_cleanup_records
    ADD COLUMN manifest_source text CHECK (manifest_source IN ('local_saved_draft','remote_detail')),
    ADD COLUMN draft_task_id uuid,
    ADD COLUMN draft_version integer CHECK (draft_version > 0);
