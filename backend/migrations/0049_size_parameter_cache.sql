CREATE TABLE product_size_parameter_cache (
    cid text NOT NULL,
    class_label text NOT NULL DEFAULT '',
    category_path text NOT NULL,
    class_options jsonb,
    definition jsonb NOT NULL,
    observed_at timestamptz NOT NULL,
    source jsonb NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version = 1),
    PRIMARY KEY (cid, class_label),
    CHECK (jsonb_typeof(definition) = 'object'),
    CHECK (class_options IS NULL OR jsonb_typeof(class_options) = 'array')
);
