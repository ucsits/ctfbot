-- Migration: 016_cleanup_orphaned_reminders
-- Description: Remove unsent reminders for tasks that are already done or cancelled
-- Date: 2026-08-15

-- Prior to the fix in completeTask() and getDueReminders(), marking a task done
-- did not delete its reminders, and the poller did not filter by task status.
-- This left orphaned rows in task_reminders that will never fire and should be
-- cleaned up.

DELETE FROM task_reminders
WHERE sent = 0
AND task_id IN (
    SELECT task_id FROM tasks WHERE status = 'done' OR cancelled = 1
);