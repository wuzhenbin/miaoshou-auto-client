CREATE TABLE published_oss_cleanup_schedule (
    scope text PRIMARY KEY,
    status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','running','succeeded','failed')),
    next_run_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
    started_at timestamptz,
    finished_at timestamptz,
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    error_code text,
    runs bigint NOT NULL DEFAULT 0
);
CREATE TABLE published_oss_cleanup_records (
    scope text NOT NULL REFERENCES published_oss_cleanup_schedule(scope),
    record_id text NOT NULL,
    collect_box_detail_id text NOT NULL,
    shop_id text NOT NULL,
    source_item_id text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
    object_keys jsonb,
    error_code text,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, record_id)
);
CREATE TABLE published_oss_cleanup_objects (
    scope text NOT NULL REFERENCES published_oss_cleanup_schedule(scope),
    object_key text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
    error_code text,
    run_id uuid,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, object_key)
);
CREATE TABLE published_oss_cleanup_runs (
    run_id uuid PRIMARY KEY,
    scope text NOT NULL REFERENCES published_oss_cleanup_schedule(scope),
    status text NOT NULL CHECK (status IN ('running','succeeded','failed')),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    success_records integer NOT NULL DEFAULT 0,
    cleaned_records integer NOT NULL DEFAULT 0,
    deleted_objects integer NOT NULL DEFAULT 0,
    failed_records integer NOT NULL DEFAULT 0,
    error_code text
);
CREATE INDEX published_oss_cleanup_runs_scope ON published_oss_cleanup_runs(scope, started_at DESC);
