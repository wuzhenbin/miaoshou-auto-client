-- Remote identity ownership is independent of the task row while DELETE waits
-- for the upstream. Association writes and reservation admission share one lock.
CREATE TABLE product_remote_deletion_reservations (
    shop_id text NOT NULL,
    temu_detail_id text NOT NULL,
    task_id uuid NOT NULL UNIQUE REFERENCES product_tasks(task_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(shop_id,temu_detail_id)
);
CREATE FUNCTION product_remote_association_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.temu_detail_id IS NULL THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(1689,hashtext(NEW.shop_id || ':' || NEW.temu_detail_id));
    IF EXISTS (SELECT 1 FROM product_remote_deletion_reservations r
        WHERE r.shop_id=NEW.shop_id AND r.temu_detail_id=NEW.temu_detail_id AND r.task_id<>NEW.task_id) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='product_remote_deletion_reserved';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER product_tasks_remote_association_guard BEFORE INSERT OR UPDATE OF shop_id,temu_detail_id
    ON product_tasks FOR EACH ROW EXECUTE FUNCTION product_remote_association_guard();
CREATE FUNCTION product_remote_deletion_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_shop text; identity_detail text;
BEGIN
    identity_shop := COALESCE(NEW.shop_id,OLD.shop_id);
    identity_detail := COALESCE(NEW.temu_detail_id,OLD.temu_detail_id);
    PERFORM pg_advisory_xact_lock(1689,hashtext(identity_shop || ':' || identity_detail));
    IF TG_OP='INSERT' AND EXISTS (SELECT 1 FROM product_tasks t
        WHERE t.shop_id=NEW.shop_id AND t.temu_detail_id=NEW.temu_detail_id AND t.task_id<>NEW.task_id) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='product_remote_deletion_shared';
    END IF;
    IF TG_OP='UPDATE' THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='product_remote_deletion_identity_immutable';
    END IF;
    RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER product_remote_deletion_reservation_guard BEFORE INSERT OR UPDATE OR DELETE
    ON product_remote_deletion_reservations FOR EACH ROW EXECUTE FUNCTION product_remote_deletion_reservation_guard();
