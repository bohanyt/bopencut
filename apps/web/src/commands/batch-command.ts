import { Command, type CommandResult } from "./base-command";

export class BatchCommand extends Command {
	constructor(private commands: Command[]) {
		super();
	}

	execute(): CommandResult | undefined {
		return this.runAll((command) => command.execute());
	}

	undo(): void {
		for (const command of [...this.commands].reverse()) {
			command.undo();
		}
	}

	redo(): CommandResult | undefined {
		return this.runAll((command) => command.redo());
	}

	// All or nothing: if one command throws (e.g. a compound cycle), the earlier ones are undone.
	private runAll(
		run: (command: Command) => CommandResult | undefined,
	): CommandResult | undefined {
		let latestSelectionResult: CommandResult | undefined;
		const done: Command[] = [];

		try {
			for (const command of this.commands) {
				const result = run(command);
				done.push(command);
				if (result?.selection !== undefined) {
					latestSelectionResult = result;
				}
			}
		} catch (error) {
			for (const command of done.reverse()) {
				command.undo();
			}
			throw error;
		}

		return latestSelectionResult;
	}
}
