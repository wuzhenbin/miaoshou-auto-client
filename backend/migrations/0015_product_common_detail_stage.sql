ALTER TABLE product_tasks DROP CONSTRAINT product_tasks_stage_check;
ALTER TABLE product_tasks ADD CONSTRAINT product_tasks_stage_check CHECK (stage IN
    ('collect','cache_common_detail','claim_platform','claim_shop','prepare_draft','save','publish','verify_publish'));
ALTER TABLE task_continuations DROP CONSTRAINT task_continuations_stage_check;
ALTER TABLE task_continuations ADD CONSTRAINT task_continuations_stage_check CHECK (stage IN
    ('collect','cache_common_detail','claim_platform','claim_shop','prepare_draft','save','publish','verify_publish'));
