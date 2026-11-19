CREATE TABLE product_common_detail_cache (
    task_id uuid PRIMARY KEY REFERENCES product_tasks (task_id) ON DELETE CASCADE,
    account_id text NOT NULL,
    common_detail_id text NOT NULL,
    source_item_id text NOT NULL,
    data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
    fetched_at timestamptz NOT NULL
);

-- Attribute-only rows cannot reconstruct a full detail; older tasks fetch on first use.
-- The legacy attribute-only table is retained but no longer read or written.
