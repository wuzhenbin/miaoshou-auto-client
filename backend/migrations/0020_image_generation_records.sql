-- Per-request execution journal. Product plans retain their business identity and allocation.
CREATE TABLE image_generation_records (
    request_id uuid PRIMARY KEY,
    status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
    phase text,
    provider_request_id text,
    snapshot jsonb NOT NULL,
    result jsonb,
    error jsonb,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX image_generation_records_status_idx ON image_generation_records(status, updated_at);
