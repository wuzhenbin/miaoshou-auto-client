CREATE TABLE product_1688_source_cache (
    task_id uuid PRIMARY KEY REFERENCES product_tasks(task_id) ON DELETE CASCADE,
    source_item_id text NOT NULL,
    source_url text NOT NULL,
    detail_url text NOT NULL,
    image_urls jsonb NOT NULL CHECK (jsonb_typeof(image_urls) = 'array'),
    fetched_at timestamptz NOT NULL DEFAULT now()
);
