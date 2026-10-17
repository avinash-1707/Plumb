// Exit codes shared by every command; see the CLI reference.
export const ExitCode = {
  Ok: 0,
  CheckFailed: 1,
  CouldNotComplete: 2,
  InvalidUsage: 3,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
