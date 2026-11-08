export const STATUS_TYPES = ["out", "sick", "remote", "travelling"] as const;
export type StatusType = (typeof STATUS_TYPES)[number];

export const STATUS_LABEL: Record<StatusType, string> = {
  out: "Out of office",
  sick: "Sick",
  remote: "Remote",
  travelling: "Travelling",
};

export const STATUS_DEFAULTS: Record<StatusType, { emoji: string; text: string }> = {
  out: { emoji: ":palm_tree:", text: "Out of office" },
  sick: { emoji: ":face_with_thermometer:", text: "Out sick" },
  remote: { emoji: ":house:", text: "Working remotely" },
  travelling: { emoji: ":airplane:", text: "Travelling" },
};

/** What the person asked for. Dates are local calendar dates (YYYY-MM-DD); `to` is the last day, inclusive. */
export type StatusInput = {
  type: StatusType;
  from: string;
  to: string;
  text: string;
  emoji: string;
};
