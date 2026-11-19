CREATE TABLE product_category_option_cache (
    cache_key text PRIMARY KEY,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    fetched_at timestamptz NOT NULL
);
