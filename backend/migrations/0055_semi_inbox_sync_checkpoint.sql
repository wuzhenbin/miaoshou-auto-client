CREATE TABLE product_semi_inbox_sync_checkpoint (
    account_id text NOT NULL,
    page_no integer NOT NULL CHECK (page_no BETWEEN 1 AND 1000),
    identities jsonb NOT NULL,
    source_lists jsonb NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, page_no),
    CHECK (jsonb_typeof(identities) = 'array'),
    CHECK (jsonb_typeof(source_lists) = 'array')
);
