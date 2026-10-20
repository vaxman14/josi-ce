-- An owner can retire obsolete work without claiming it succeeded. Its full
-- step and plan history remain. New effects wait for an explicitly revised plan.
alter table work_goals add column plan_review_required boolean not null default false;
