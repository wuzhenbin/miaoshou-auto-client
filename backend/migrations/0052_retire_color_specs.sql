-- Retire the color gate without deleting evidence or reverting applied drafts.
-- Run only after production requests have drained and the backend has stopped.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM product_edit_runs WHERE node_key='color_specs' AND status='running') THEN
        RAISE EXCEPTION 'color_specs request still running; reconcile before retiring';
    END IF;
END $$;

-- Require explicit Continue for work stopped by this gate; do not replay models,
-- regenerate images, write drafts or save upstream as part of the migration.
UPDATE product_tasks t SET error=NULL,version=version+1,updated_at=now(),
    automatic_finished_at=COALESCE(automatic_finished_at,now())
WHERE t.status IN ('awaiting_review','failed') AND t.stage='prepare_draft'
AND (t.error->>'code' IN ('color_specs_required','color_specs_failed','color_specs_request_failed')
    OR EXISTS (SELECT 1 FROM product_edit_runs r WHERE r.task_id=t.task_id
        AND NOT(r.data ? 'supersededBy') AND (r.node_key='color_specs' AND r.status='queued'
            OR r.data->>'blockedByNode'='color_specs')));

UPDATE product_edit_runs SET
    status=CASE WHEN status='queued' THEN 'failed' ELSE status END,
    error=CASE WHEN status='queued' THEN '颜色规格映射节点已撤回，未执行' ELSE error END,
    completed_at=CASE WHEN status='queued' THEN now() ELSE completed_at END,
    data=data || '{"supersededBy":"color-specs-retired","retiredReason":"恢复类别确认后直接进入填表及商品生图的流程"}'::jsonb
WHERE NOT(data ? 'supersededBy')
AND (node_key='color_specs' OR data->>'blockedByNode'='color_specs');
