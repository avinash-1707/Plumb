/** Plumb could not complete (not a git repo, invalid config, no map yet). The message names the blocker. */
export class CouldNotCompleteError extends Error {}

/** The command line names something that does not exist or cannot be parsed. */
export class UsageError extends Error {}
