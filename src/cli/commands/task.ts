import { Command, Option } from 'commander';
import { COMMON_FLAGS } from '../../core/completions/shared-flags.js';
import type {
  TaskAction,
  TaskCreateOptions,
  TaskEditOptions,
  TaskMoveOptions,
  TaskOptions,
  TaskRemoveOptions,
  TaskReorderOptions,
  TaskSplitOptions,
} from '../../commands/task.js';

export interface RegisterTaskCommandHelpers {
  hiddenStorePathOption: () => Option;
  failWithError: (
    error: unknown,
    json?: { enabled: boolean | undefined; payload?: Record<string, unknown>; fallbackCode?: string }
  ) => Promise<void>;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function addSharedOrgTaskFlags(command: Command, hiddenStorePathOption: () => Option): Command {
  return command
    .requiredOption('--change <id>', 'Change name')
    .option('--json', 'Output as JSON')
    .option('--store <id>', COMMON_FLAGS.store.description)
    .addOption(hiddenStorePathOption());
}

function addMutationConfirmFlags(command: Command): Command {
  return command
    .option('--preview', 'Preview changes and previewHash without writing')
    .option('--confirm', 'Confirm structural write in non-interactive mode')
    .option('--preview-hash <hash>', 'Expected previewHash from --preview');
}

export function registerTaskCommand(
  program: Command,
  helpers: RegisterTaskCommandHelpers
): void {
  const { hiddenStorePathOption, failWithError } = helpers;
  const task = program.command('task').description('Read and edit native Org tasks');

  const runTaskAction = async <TOptions extends { json?: boolean }>(
    command: Command,
    fn: (options: TOptions) => Promise<void>
  ): Promise<void> => {
    const options = command.opts<TOptions>();
    try {
      await fn(options);
    } catch (error) {
      await failWithError(error, { enabled: options.json, fallbackCode: 'task_error' });
      process.exitCode = 1;
    }
  };

  for (const action of ['list', 'show', 'next'] as const satisfies readonly TaskAction[]) {
    const command = addSharedOrgTaskFlags(
      task
        .command(action === 'show' ? 'show <task-id>' : action)
        .description(
          action === 'list'
            ? 'List tasks in document order'
            : action === 'show'
              ? 'Show one task'
              : 'Find the next task'
        ),
      hiddenStorePathOption
    );
    if (action === 'show') {
      command.option('--sections <names>', 'Select description, criteria, evidence, custom, or all');
    }
    command.action(async (...args) => {
      await runTaskAction<TaskOptions>(command, async (options) => {
        const { taskCommand } = await import('../../commands/task.js');
        await taskCommand(action, options, action === 'show' ? (args[0] as string) : undefined);
      });
    });
  }

  const createCmd = addMutationConfirmFlags(
    addSharedOrgTaskFlags(
      task
        .command('create')
        .description('Create a new native Org task')
        .requiredOption('--id <task-id>', 'Unique TASK_ID for the new task')
        .requiredOption('--title <text>', 'Task title')
        .option('--description <text>', 'Task description body')
        .option('--criteria <text>', 'Acceptance criteria body')
        .option('--depends-on <ids>', 'Comma-separated dependency task IDs')
        .option('--group <path>', 'Target group title or path (use "/" for top-level)')
        .option('--position <pos>', 'Insertion position within group: start or end')
        .option('--before <task-id>', 'Insert before an existing task ID')
        .option('--after <task-id>', 'Insert after an existing task ID'),
      hiddenStorePathOption
    )
  );
  createCmd.action(async () => {
    await runTaskAction<TaskCreateOptions>(createCmd, async (options) => {
      const { taskCreateCommand } = await import('../../commands/task.js');
      await taskCreateCommand(options);
    });
  });

  const editCmd = addMutationConfirmFlags(
    addSharedOrgTaskFlags(
      task
        .command('edit <task-id>')
        .description('Edit an existing native Org task without overwriting evidence')
        .option('--title <text>', 'Updated task title')
        .option('--description <text>', 'Updated description body')
        .option('--criteria <text>', 'Updated acceptance criteria body')
        .option('--depends-on <ids>', 'Updated comma-separated dependency task IDs (empty clears)')
        .option('--custom <name=content>', 'Create or update a custom section (repeatable)', collectOption, [] as string[]),
      hiddenStorePathOption
    )
  );
  editCmd.action(async (taskId: string) => {
    await runTaskAction<TaskEditOptions>(editCmd, async (options) => {
      const { taskEditCommand } = await import('../../commands/task.js');
      await taskEditCommand(taskId, options);
    });
  });

  const removeCmd = addMutationConfirmFlags(
    addSharedOrgTaskFlags(
      task.command('remove <task-id>').description('Remove an eligible TODO Org task'),
      hiddenStorePathOption
    )
  );
  removeCmd.action(async (taskId: string) => {
    await runTaskAction<TaskRemoveOptions>(removeCmd, async (options) => {
      const { taskRemoveCommand } = await import('../../commands/task.js');
      await taskRemoveCommand(taskId, options);
    });
  });

  const reorderCmd = addMutationConfirmFlags(
    addSharedOrgTaskFlags(
      task
        .command('reorder <task-ids...>')
        .description('Reorder selected tasks within the same group'),
      hiddenStorePathOption
    )
  );
  reorderCmd.action(async (taskIds: string[]) => {
    await runTaskAction<TaskReorderOptions>(reorderCmd, async (options) => {
      const { taskReorderCommand } = await import('../../commands/task.js');
      await taskReorderCommand(taskIds, options);
    });
  });

  const moveCmd = addMutationConfirmFlags(
    addSharedOrgTaskFlags(
      task
        .command('move <task-id>')
        .description('Move a task subtree to another group or position')
        .option('--group <path>', 'Target group title or path (use "/" for top-level)')
        .option('--position <pos>', 'Target position within group: start or end')
        .option('--before <task-id>', 'Move before an existing task ID')
        .option('--after <task-id>', 'Move after an existing task ID'),
      hiddenStorePathOption
    )
  );
  moveCmd.action(async (taskId: string) => {
    await runTaskAction<TaskMoveOptions>(moveCmd, async (options) => {
      const { taskMoveCommand } = await import('../../commands/task.js');
      await taskMoveCommand(taskId, options);
    });
  });

  const splitCmd = addMutationConfirmFlags(
    addSharedOrgTaskFlags(
      task
        .command('split <task-id>')
        .description('Split a TODO task into two or more replacement tasks')
        .option(
          '--into <spec>',
          'Replacement task as <id>=<title> or JSON object (repeatable, at least 2)',
          collectOption,
          [] as string[]
        ),
      hiddenStorePathOption
    )
  );
  splitCmd.action(async (taskId: string) => {
    await runTaskAction<TaskSplitOptions>(splitCmd, async (options) => {
      const { taskSplitCommand } = await import('../../commands/task.js');
      await taskSplitCommand(taskId, options);
    });
  });
}
