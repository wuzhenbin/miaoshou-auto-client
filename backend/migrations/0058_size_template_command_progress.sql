-- The dispatch identity survives an HTTP timeout and process restart. Progress is advisory only.
CREATE TABLE size_template_command_progress (
    command_id uuid PRIMARY KEY,
    task_id uuid NOT NULL,
    client_id uuid NOT NULL,
    stage text,
    stage_rank smallint NOT NULL DEFAULT 0 CHECK (stage_rank BETWEEN 0 AND 4),
    occurred_at timestamptz,
    reported_at timestamptz,
    dispatched_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((stage IS NULL AND stage_rank = 0) OR
        (stage = 'received' AND stage_rank = 1) OR
        (stage = 'filling' AND stage_rank = 2) OR
        (stage = 'save_boundary' AND stage_rank = 3) OR
        (stage = 'result' AND stage_rank = 4))
);
CREATE INDEX size_template_command_progress_task_idx
    ON size_template_command_progress (task_id, dispatched_at DESC, command_id DESC);
