CREATE TABLE task_batches (
    batch_id uuid PRIMARY KEY,
    caller_id text NOT NULL CHECK (caller_id <> ''),
    account_id text NOT NULL CHECK (account_id <> ''),
    shop_id text NOT NULL CHECK (shop_id ~ '^[1-9][0-9]*$'),
    publish_site text NOT NULL CHECK (publish_site <> '' AND publish_site <> 'EU'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (batch_id, account_id, shop_id, publish_site)
);

CREATE TABLE product_tasks (
    task_id uuid PRIMARY KEY,
    batch_id uuid NOT NULL,
    client_item_id text NOT NULL CHECK (length(client_item_id) BETWEEN 1 AND 64),
    account_id text NOT NULL,
    source_item_id text NOT NULL CHECK (source_item_id ~ '^[1-9][0-9]*$'),
    source_url text NOT NULL,
    shop_id text NOT NULL,
    publish_site text NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN
        ('queued','running','awaiting_review','saved','publishing','needs_attention','failed','succeeded','cancelled')),
    stage text NOT NULL DEFAULT 'collect' CHECK (stage IN
        ('collect','claim_platform','claim_shop','prepare_draft','save','publish','verify_publish')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    draft_version integer CHECK (draft_version > 0),
    saved_draft_version integer CHECK (saved_draft_version > 0),
    attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
    common_detail_id text,
    temu_detail_id text,
    move_collect_task_detail_id text,
    platform_item_id text,
    error jsonb,
    snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(snapshot) = 'object'),
    has_unresolved_operation boolean NOT NULL DEFAULT false,
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (batch_id, client_item_id),
    UNIQUE (task_id, account_id, shop_id, publish_site),
    FOREIGN KEY (batch_id, account_id, shop_id, publish_site)
        REFERENCES task_batches (batch_id, account_id, shop_id, publish_site)
);
-- Published history and uncertain terminal tasks retain the same dedup reservation.
CREATE UNIQUE INDEX product_tasks_dedup ON product_tasks
    (account_id, source_item_id, shop_id, publish_site)
    WHERE status NOT IN ('failed','cancelled') OR has_unresolved_operation OR published_at IS NOT NULL;
CREATE INDEX product_tasks_created ON product_tasks (created_at DESC, task_id DESC);
CREATE INDEX product_tasks_batch ON product_tasks (batch_id, created_at DESC, task_id DESC);
CREATE INDEX product_tasks_status ON product_tasks (status, created_at DESC, task_id DESC);

CREATE TABLE task_drafts (
    task_id uuid NOT NULL REFERENCES product_tasks (task_id),
    draft_version integer NOT NULL CHECK (draft_version > 0),
    snapshot_id uuid NOT NULL UNIQUE,
    document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
    remote_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(remote_snapshot) = 'object'),
    changes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(changes) = 'object'),
    validation_issues jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(validation_issues) = 'array'),
    payload_summary jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload_summary) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, draft_version)
);
ALTER TABLE product_tasks ADD FOREIGN KEY (task_id, draft_version)
    REFERENCES task_drafts (task_id, draft_version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE product_tasks ADD FOREIGN KEY (task_id, saved_draft_version)
    REFERENCES task_drafts (task_id, draft_version) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION product_draft_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product_draft_immutable';
END;
$$;
CREATE TRIGGER task_drafts_immutable BEFORE UPDATE OR DELETE ON task_drafts
    FOR EACH ROW EXECUTE FUNCTION product_draft_immutable();

CREATE TABLE task_actions (
    action_id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES product_tasks (task_id),
    type text NOT NULL CHECK (type IN ('approve_save','publish','retry','reconcile','cancel')),
    status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','running','succeeded','failed','cancelled')),
    expected_version integer NOT NULL CHECK (expected_version > 0),
    draft_version integer,
    operator_id text NOT NULL DEFAULT 'local-operator',
    note text CHECK (length(note) <= 500),
    payload_hash text,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (task_id, action_id),
    FOREIGN KEY (task_id, draft_version) REFERENCES task_drafts (task_id, draft_version),
    CHECK (type NOT IN ('approve_save','publish') OR draft_version IS NOT NULL)
);
CREATE INDEX task_actions_task ON task_actions (task_id, created_at, action_id);

CREATE TABLE task_continuations (
    continuation_id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES product_tasks (task_id),
    action_id uuid,
    stage text NOT NULL CHECK (stage IN
        ('collect','claim_platform','claim_shop','prepare_draft','save','publish','verify_publish')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','cancelled')),
    enqueue_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    available_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (task_id, action_id) REFERENCES task_actions (task_id, action_id)
);
CREATE UNIQUE INDEX task_continuations_active ON task_continuations (task_id)
    WHERE status IN ('pending','running');
CREATE INDEX task_continuations_ready ON task_continuations (available_at, enqueue_seq)
    WHERE status = 'pending';

CREATE TABLE upstream_operations (
    operation_id uuid PRIMARY KEY,
    task_id uuid NOT NULL,
    action_id uuid,
    account_id text NOT NULL,
    shop_id text NOT NULL,
    publish_site text NOT NULL,
    temu_detail_id text,
    kind text NOT NULL CHECK (kind IN ('collect','claim_platform','claim_shop','save','publish')),
    status text NOT NULL DEFAULT 'intent' CHECK (status IN ('intent','uncertain','confirmed','failed')),
    payload_hash text NOT NULL CHECK (payload_hash <> ''),
    intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
    result jsonb,
    publish_baseline jsonb,
    submitted_at timestamptz,
    confirmed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (task_id, operation_id),
    FOREIGN KEY (task_id, account_id, shop_id, publish_site)
        REFERENCES product_tasks (task_id, account_id, shop_id, publish_site),
    FOREIGN KEY (task_id, action_id) REFERENCES task_actions (task_id, action_id),
    CHECK (kind <> 'publish' OR temu_detail_id IS NOT NULL)
);
CREATE INDEX upstream_operations_task ON upstream_operations (task_id, created_at, operation_id);
CREATE UNIQUE INDEX upstream_operations_active_publish ON upstream_operations
    (account_id, temu_detail_id, shop_id, publish_site)
    WHERE kind = 'publish' AND status IN ('intent','uncertain','confirmed');

-- Lock the parent before changing an operation; status edits and uncertainty updates serialize.
CREATE FUNCTION product_operation_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product_operation_history_required';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.task_id, NEW.operation_id) IS DISTINCT FROM (OLD.task_id, OLD.operation_id) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product_operation_identity_immutable';
    END IF;
    PERFORM 1 FROM product_tasks WHERE task_id = COALESCE(NEW.task_id, OLD.task_id) FOR UPDATE;
    RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER upstream_operations_lock BEFORE INSERT OR UPDATE OR DELETE ON upstream_operations
    FOR EACH ROW EXECUTE FUNCTION product_operation_lock();
CREATE FUNCTION product_task_reservations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.has_unresolved_operation := EXISTS (SELECT 1 FROM upstream_operations
        WHERE task_id = NEW.task_id AND status IN ('intent','uncertain'));
    IF TG_OP = 'UPDATE' AND OLD.published_at IS NOT NULL THEN
        NEW.published_at := OLD.published_at;
    ELSIF NEW.status = 'succeeded' THEN
        NEW.published_at := COALESCE(NEW.published_at, now());
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER product_tasks_reservations BEFORE INSERT OR UPDATE ON product_tasks
    FOR EACH ROW EXECUTE FUNCTION product_task_reservations();
CREATE FUNCTION product_operation_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE product_tasks SET has_unresolved_operation = false
        WHERE task_id = COALESCE(NEW.task_id, OLD.task_id);
    RETURN NULL;
END;
$$;
CREATE TRIGGER upstream_operations_reservation AFTER INSERT OR UPDATE OR DELETE ON upstream_operations
    FOR EACH ROW EXECUTE FUNCTION product_operation_reservation();

CREATE TABLE task_events (
    event_id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES product_tasks (task_id),
    seq integer NOT NULL CHECK (seq > 0),
    action_id uuid,
    operation_id uuid,
    type text NOT NULL,
    data jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (task_id, seq),
    FOREIGN KEY (task_id, action_id) REFERENCES task_actions (task_id, action_id),
    FOREIGN KEY (task_id, operation_id) REFERENCES upstream_operations (task_id, operation_id)
);

CREATE TABLE idempotency_records (
    caller_id text NOT NULL,
    resource text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash <> ''),
    response_status integer NOT NULL CHECK (response_status BETWEEN 100 AND 599),
    response_body jsonb NOT NULL,
    response_headers jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(response_headers) = 'object'),
    batch_id uuid REFERENCES task_batches (batch_id),
    task_id uuid REFERENCES product_tasks (task_id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (caller_id, resource, idempotency_key)
);
