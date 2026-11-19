CREATE TABLE product_attribute_fill_runs (
    run_id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES product_tasks (task_id) ON DELETE CASCADE,
    client_request_id uuid NOT NULL,
    admission_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    input_draft_version bigint NOT NULL CHECK (input_draft_version BETWEEN 1 AND 9007199254740991),
    draft_snapshot jsonb NOT NULL CHECK (jsonb_typeof(draft_snapshot) = 'object'),
    binding_snapshot jsonb NOT NULL CHECK (jsonb_typeof(binding_snapshot) = 'object'),
    config_version text NOT NULL CHECK (config_version ~ '^[a-f0-9]{64}$'),
    model jsonb NOT NULL CHECK (jsonb_typeof(model) = 'object'),
    system_prompt text NOT NULL CHECK (system_prompt ~ '\S'),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
    phase text CHECK (phase IN ('preparing','generating','validating')),
    input_snapshot jsonb CHECK (jsonb_typeof(input_snapshot) = 'object'),
    context_summary jsonb CHECK (jsonb_typeof(context_summary) = 'object'),
    context_fingerprint text CHECK (context_fingerprint ~ '^[a-f0-9]{64}$'),
    result jsonb CHECK (jsonb_typeof(result) = 'object'),
    error jsonb CHECK (jsonb_typeof(error) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    started_at timestamptz,
    finished_at timestamptz,
    UNIQUE (task_id, client_request_id),
    CHECK ((input_snapshot IS NULL AND context_summary IS NULL AND context_fingerprint IS NULL)
        OR (input_snapshot IS NOT NULL AND context_summary IS NOT NULL AND context_fingerprint IS NOT NULL)),
    CHECK (
        (status = 'queued' AND phase IS NULL AND started_at IS NULL AND finished_at IS NULL
            AND input_snapshot IS NULL AND result IS NULL AND error IS NULL)
        OR (status = 'running' AND phase IS NOT NULL AND started_at IS NOT NULL AND finished_at IS NULL
            AND result IS NULL AND error IS NULL AND (phase = 'preparing' OR input_snapshot IS NOT NULL))
        OR (status = 'succeeded' AND phase IS NULL AND started_at IS NOT NULL AND finished_at IS NOT NULL
            AND input_snapshot IS NOT NULL AND result IS NOT NULL AND error IS NULL)
        OR (status = 'failed' AND phase IS NULL AND finished_at IS NOT NULL AND result IS NULL AND error IS NOT NULL)
    ),
    CHECK (started_at IS NULL OR started_at >= created_at),
    CHECK (finished_at IS NULL OR finished_at >= COALESCE(started_at, created_at))
);
CREATE UNIQUE INDEX product_attribute_fill_one_active ON product_attribute_fill_runs (task_id)
    WHERE status IN ('queued','running');
CREATE INDEX product_attribute_fill_latest ON product_attribute_fill_runs (task_id, admission_seq DESC);

CREATE FUNCTION product_attribute_fill_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.run_id, NEW.task_id, NEW.client_request_id, NEW.admission_seq, NEW.input_draft_version,
        NEW.draft_snapshot, NEW.binding_snapshot, NEW.config_version, NEW.model, NEW.system_prompt, NEW.created_at)
        IS DISTINCT FROM
        (OLD.run_id, OLD.task_id, OLD.client_request_id, OLD.admission_seq, OLD.input_draft_version,
        OLD.draft_snapshot, OLD.binding_snapshot, OLD.config_version, OLD.model, OLD.system_prompt, OLD.created_at)
        OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
        OR (OLD.input_snapshot IS NOT NULL AND
            (NEW.input_snapshot, NEW.context_summary, NEW.context_fingerprint) IS DISTINCT FROM
            (OLD.input_snapshot, OLD.context_summary, OLD.context_fingerprint))
        OR OLD.status IN ('succeeded','failed') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'attribute_fill_history_immutable';
    END IF;
    IF NOT (
        (OLD.status = 'queued' AND (NEW.status = 'failed' OR (NEW.status = 'running' AND NEW.phase = 'preparing')))
        OR (OLD.status = 'running' AND NEW.status = 'failed')
        OR (OLD.status = 'running' AND NEW.status = 'running' AND
            ((OLD.phase = 'preparing' AND NEW.phase IN ('preparing','generating'))
            OR (OLD.phase = 'generating' AND NEW.phase = 'validating')))
        OR (OLD.status = 'running' AND OLD.phase = 'validating' AND NEW.status = 'succeeded')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'attribute_fill_invalid_transition';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER product_attribute_fill_immutable BEFORE UPDATE ON product_attribute_fill_runs
    FOR EACH ROW EXECUTE FUNCTION product_attribute_fill_immutable();
