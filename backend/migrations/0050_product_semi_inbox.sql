-- Separate identities and membership from the historical public inbox cache.
CREATE TABLE product_semi_inbox_sync (
    account_id text PRIMARY KEY,
    latest_created_at timestamptz,
    synced_at timestamptz NOT NULL DEFAULT now(),
    full_synced_at timestamptz
);
CREATE TABLE product_semi_inbox_cache (
    account_id text NOT NULL,
    temu_detail_id text NOT NULL CHECK (temu_detail_id ~ '^[1-9][0-9]*$'),
    created_at timestamptz NOT NULL,
    payload jsonb NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, temu_detail_id)
);
