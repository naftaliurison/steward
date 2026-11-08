import type { SubmittedView } from "@steward/availability";

export type SlackUser = { id: string; username?: string; name?: string };

export type ViewSubmissionPayload = {
  type: "view_submission";
  team: { id: string };
  user: SlackUser;
  view: SubmittedView;
};

export type BlockActionsPayload = {
  type: "block_actions";
  team: { id: string };
  user: SlackUser;
  response_url?: string;
  actions: { action_id: string; value?: string }[];
};

export type InteractionPayload =
  | ViewSubmissionPayload
  | BlockActionsPayload
  | { type: string; team: { id: string }; user: SlackUser };
