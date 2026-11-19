CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE product_category_embedding_indexes (
    scope text PRIMARY KEY,
    root_cids text[] NOT NULL,
    scope_version text NOT NULL,
    tree_version text NOT NULL,
    tree_fetched_at timestamptz NOT NULL,
    provider text NOT NULL,
    model_id text NOT NULL,
    model_digest text NOT NULL,
    dimensions integer NOT NULL CHECK (dimensions = 2560),
    text_version text NOT NULL,
    build_id uuid NOT NULL,
    indexed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_category_embeddings (
    scope text NOT NULL REFERENCES product_category_embedding_indexes(scope),
    cid text NOT NULL,
    path text NOT NULL,
    ancestor_ids text[] NOT NULL,
    embedding vector(2560) NOT NULL,
    PRIMARY KEY (scope, cid)
);

-- Small category corpus: exact cosine search preserves all 2560 dimensions.
-- No approximate index: vector HNSW/IVFFlat indexes have a 2000-dimension limit.
