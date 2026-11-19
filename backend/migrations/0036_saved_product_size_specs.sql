-- Historical saved products accept their saved specifications without executing either branch.
INSERT INTO product_edit_runs (
    run_id, task_id, node_key, mode, status, input_draft_version,
    output_draft_version, data, completed_at
)
SELECT gen_random_uuid(), t.task_id, 'size_specs', 'automatic', 'succeeded',
    t.draft_version, t.draft_version,
    jsonb_build_object(
        'prepared', false,
        'reason', '历史商品已成功保存，沿用已保存尺码规格',
        'saleSourceFallback', jsonb_build_object(
            'policy', 'saved-product-accepted',
            'restoredSkuCount', CASE
                WHEN jsonb_typeof(d.document #> '{shopCollectItemInfo,skuMap}') = 'object'
                THEN (SELECT count(*) FROM jsonb_object_keys(d.document #> '{shopCollectItemInfo,skuMap}'))
                ELSE 0 END
        )
    ), now()
FROM product_tasks t
JOIN task_drafts d ON d.task_id = t.task_id AND d.draft_version = t.draft_version
WHERE t.status IN ('saved', 'succeeded')
    AND t.saved_draft_version = t.draft_version
    AND NOT t.has_unresolved_operation
    AND NOT EXISTS (SELECT 1 FROM product_edit_runs r WHERE r.task_id = t.task_id AND r.node_key = 'size_specs')
    AND NOT EXISTS (SELECT 1 FROM product_edit_runs r WHERE r.task_id = t.task_id AND r.status IN ('queued', 'running'));
