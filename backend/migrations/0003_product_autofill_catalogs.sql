-- Append-only catalog and rule history. Latest catalog revision is the active revision.
CREATE TABLE product_autofill_rules (
    rule_id text NOT NULL,
    version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
    hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
    document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rule_id, version)
);
CREATE TABLE product_autofill_catalogs (
    revision bigint PRIMARY KEY CHECK (revision BETWEEN 1 AND 9007199254740991),
    hash text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$'),
    document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION product_autofill_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product_autofill_immutable';
END;
$$;
CREATE TRIGGER product_autofill_rules_immutable BEFORE UPDATE OR DELETE ON product_autofill_rules
    FOR EACH ROW EXECUTE FUNCTION product_autofill_immutable();
CREATE TRIGGER product_autofill_catalogs_immutable BEFORE UPDATE OR DELETE ON product_autofill_catalogs
    FOR EACH ROW EXECUTE FUNCTION product_autofill_immutable();
