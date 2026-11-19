CREATE TABLE online_client_result_receipts (
    command_id uuid PRIMARY KEY,
    client_id uuid NOT NULL,
    command_kind text,
    result jsonb NOT NULL,
    orphaned boolean NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX online_client_result_receipts_orphaned_idx
    ON online_client_result_receipts (received_at)
    WHERE orphaned;
