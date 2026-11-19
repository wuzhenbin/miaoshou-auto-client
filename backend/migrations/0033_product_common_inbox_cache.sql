CREATE TABLE product_common_inbox_sync (
    account_id text PRIMARY KEY,
    latest_created_at timestamptz,
    synced_at timestamptz NOT NULL
);
CREATE TABLE product_common_inbox_cache (
    account_id text NOT NULL,
    common_detail_id text NOT NULL,
    created_at timestamptz NOT NULL,
    payload jsonb NOT NULL,
    fetched_at timestamptz NOT NULL,
    PRIMARY KEY (account_id, common_detail_id)
);
CREATE INDEX product_common_inbox_cache_created_idx
    ON product_common_inbox_cache (account_id, created_at DESC, common_detail_id DESC);
