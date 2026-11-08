export type PlainText = { type: "plain_text"; text: string; emoji?: boolean };
export type Mrkdwn = { type: "mrkdwn"; text: string };
export type TextObject = PlainText | Mrkdwn;
export type Option = { text: PlainText; value: string };

export type Button = {
  type: "button";
  text: PlainText;
  action_id: string;
  value?: string;
  url?: string;
  style?: "primary" | "danger";
};
export type StaticSelect = {
  type: "static_select";
  action_id: string;
  options: Option[];
  initial_option?: Option;
  placeholder?: PlainText;
};
export type Datepicker = { type: "datepicker"; action_id: string; initial_date?: string };
export type PlainTextInput = {
  type: "plain_text_input";
  action_id: string;
  initial_value?: string;
  placeholder?: PlainText;
  multiline?: boolean;
};
export type Element = Button | StaticSelect | Datepicker | PlainTextInput;

export type HeaderBlock = { type: "header"; text: PlainText };
export type SectionBlock = {
  type: "section";
  text?: TextObject;
  fields?: TextObject[];
  accessory?: Element;
  block_id?: string;
};
export type ActionsBlock = { type: "actions"; elements: Element[]; block_id?: string };
export type ContextBlock = { type: "context"; elements: TextObject[] };
export type DividerBlock = { type: "divider" };
export type InputBlock = {
  type: "input";
  block_id: string;
  label: PlainText;
  element: Element;
  optional?: boolean;
};
export type Block =
  | HeaderBlock
  | SectionBlock
  | ActionsBlock
  | ContextBlock
  | DividerBlock
  | InputBlock;

export type ModalView = {
  type: "modal";
  callback_id: string;
  title: PlainText;
  submit?: PlainText;
  close?: PlainText;
  blocks: Block[];
  private_metadata?: string;
};

export const plain = (text: string): PlainText => ({ type: "plain_text", text, emoji: true });
export const mrkdwn = (text: string): Mrkdwn => ({ type: "mrkdwn", text });
export const header = (text: string): HeaderBlock => ({ type: "header", text: plain(text) });
export const section = (text: string): SectionBlock => ({ type: "section", text: mrkdwn(text) });
export const context = (...texts: string[]): ContextBlock => ({
  type: "context",
  elements: texts.map(mrkdwn),
});
export const divider = (): DividerBlock => ({ type: "divider" });
export const actions = (...elements: Element[]): ActionsBlock => ({ type: "actions", elements });
export const option = (text: string, value: string): Option => ({ text: plain(text), value });
export const button = (
  text: string,
  actionId: string,
  opts: { value?: string; style?: "primary" | "danger"; url?: string } = {},
): Button => ({ type: "button", text: plain(text), action_id: actionId, ...opts });
export const staticSelect = (
  actionId: string,
  options: Option[],
  initial?: Option,
): StaticSelect => ({
  type: "static_select",
  action_id: actionId,
  options,
  ...(initial ? { initial_option: initial } : {}),
});
export const datepicker = (actionId: string, initialDate?: string): Datepicker => ({
  type: "datepicker",
  action_id: actionId,
  ...(initialDate ? { initial_date: initialDate } : {}),
});
export const textInput = (
  actionId: string,
  initialValue?: string,
  placeholder?: string,
): PlainTextInput => ({
  type: "plain_text_input",
  action_id: actionId,
  ...(initialValue ? { initial_value: initialValue } : {}),
  ...(placeholder ? { placeholder: plain(placeholder) } : {}),
});
export const input = (
  blockId: string,
  label: string,
  element: Element,
  optional = false,
): InputBlock => ({
  type: "input",
  block_id: blockId,
  label: plain(label),
  element,
  optional,
});
