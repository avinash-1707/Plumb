export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}
