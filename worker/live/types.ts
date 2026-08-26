export type Tab = {
  view: any;
  url: string;
  title: string;
};

export type PromptAction = "command" | "open" | "tab";

export type MouseInput = {
  code: number;
  button: number;
  wheel: "up" | "down" | null;
  x: number;
  y: number;
  down: boolean;
};
