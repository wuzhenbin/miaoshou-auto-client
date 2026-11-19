CREATE TABLE product_source_attribute_cache (
    task_id uuid PRIMARY KEY REFERENCES product_tasks (task_id) ON DELETE CASCADE,
    account_id text NOT NULL,
    common_detail_id text NOT NULL,
    source_item_id text NOT NULL,
    attributes jsonb NOT NULL CHECK (jsonb_typeof(attributes) = 'array'),
    fetched_at timestamptz NOT NULL
);
