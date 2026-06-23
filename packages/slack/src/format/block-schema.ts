// The validated Block Kit subset the agent authors through `reply_with_blocks`.
// Mirrors Slack's field names so the skill can lean on Slack's reference. Purely
// structural: cross-field rules (section text|fields, card one-of) and action_id
// assignment live in `./blocks.ts`, keeping the discriminated `variant` options as
// plain objects (valibot `variant` inspects object entries for the discriminator).

import * as v from "valibot";

const bounded = (max?: number) =>
  max ? v.pipe(v.string(), v.minLength(1), v.maxLength(max)) : v.pipe(v.string(), v.minLength(1));

const plainText = (max?: number) =>
  v.object({ type: v.literal("plain_text"), text: bounded(max), emoji: v.optional(v.boolean()) });
const mrkdwn = (max?: number) => v.object({ type: v.literal("mrkdwn"), text: bounded(max) });
const textObject = (max?: number) => v.variant("type", [plainText(max), mrkdwn(max)]);

const ActionId = v.pipe(v.string(), v.minLength(1), v.maxLength(255));
const Value = v.pipe(v.string(), v.minLength(1), v.maxLength(2000));

export const ImageElement = v.object({
  type: v.literal("image"),
  image_url: v.pipe(v.string(), v.minLength(1), v.maxLength(3000)),
  alt_text: v.pipe(v.string(), v.minLength(1)),
});

export const Button = v.object({
  type: v.literal("button"),
  text: plainText(75),
  value: v.optional(Value),
  action_id: v.optional(ActionId),
  style: v.optional(v.picklist(["primary", "danger"])),
  url: v.optional(v.pipe(v.string(), v.maxLength(3000))),
});

const SelectOption = v.object({ text: plainText(75), value: Value });

export const Overflow = v.object({
  type: v.literal("overflow"),
  action_id: v.optional(ActionId),
  options: v.pipe(v.array(SelectOption), v.minLength(2), v.maxLength(5)),
});

export const StaticSelect = v.object({
  type: v.literal("static_select"),
  action_id: v.optional(ActionId),
  placeholder: plainText(150),
  options: v.pipe(v.array(SelectOption), v.minLength(1), v.maxLength(100)),
});

const InteractiveElement = v.variant("type", [Button, Overflow, StaticSelect]);
const Accessory = v.variant("type", [Button, Overflow, StaticSelect, ImageElement]);

const MarkdownBlock = v.object({ type: v.literal("markdown"), text: bounded(12000) });
const HeaderBlock = v.object({ type: v.literal("header"), text: plainText(150) });
const SectionBlock = v.object({
  type: v.literal("section"),
  text: v.optional(textObject(3000)),
  fields: v.optional(v.pipe(v.array(textObject(2000)), v.minLength(1), v.maxLength(10))),
  accessory: v.optional(Accessory),
});
const ContextBlock = v.object({
  type: v.literal("context"),
  elements: v.pipe(
    v.array(v.variant("type", [plainText(), mrkdwn(), ImageElement])),
    v.minLength(1),
    v.maxLength(10),
  ),
});
const DividerBlock = v.object({ type: v.literal("divider") });
const ImageBlock = v.object({
  type: v.literal("image"),
  image_url: v.pipe(v.string(), v.minLength(1), v.maxLength(3000)),
  alt_text: v.pipe(v.string(), v.minLength(1)),
  title: v.optional(plainText(2000)),
});
const ActionsBlock = v.object({
  type: v.literal("actions"),
  elements: v.pipe(v.array(InteractiveElement), v.minLength(1), v.maxLength(5)),
});
const TableCell = v.object({ type: v.literal("raw_text"), text: v.string() });
const TableBlock = v.object({
  type: v.literal("table"),
  rows: v.pipe(
    v.array(v.pipe(v.array(TableCell), v.minLength(1), v.maxLength(20))),
    v.minLength(1),
    v.maxLength(100),
  ),
});
const CardActions = v.object({
  type: v.literal("actions"),
  elements: v.pipe(v.array(Button), v.minLength(1), v.maxLength(3)),
});
const CardBlock = v.object({
  type: v.literal("card"),
  title: v.optional(textObject(150)),
  subtitle: v.optional(textObject(150)),
  body: v.optional(textObject(200)),
  subtext: v.optional(textObject(200)),
  icon: v.optional(ImageElement),
  hero_image: v.optional(ImageElement),
  actions: v.optional(CardActions),
});

const PositiveNumber = v.pipe(
  v.number(),
  v.check((n) => n > 0, "value must be greater than 0"),
);
const PieSegment = v.object({ label: bounded(20), value: PositiveNumber });
const PieChart = v.object({
  type: v.literal("pie"),
  segments: v.pipe(v.array(PieSegment), v.minLength(1), v.maxLength(6)),
});
const DataPoint = v.object({ label: bounded(20), value: v.number() });
const Series = v.object({
  name: bounded(20),
  data: v.pipe(v.array(DataPoint), v.minLength(1)),
});
const AxisConfig = v.object({
  categories: v.pipe(v.array(bounded(20)), v.minLength(1)),
  x_label: v.optional(bounded(50)),
  y_label: v.optional(bounded(50)),
});
const CartesianChart = v.object({
  type: v.picklist(["bar", "area", "line"]),
  series: v.pipe(v.array(Series), v.minLength(1), v.maxLength(6)),
  axis_config: AxisConfig,
});
const DataVisualizationBlock = v.object({
  type: v.literal("data_visualization"),
  title: bounded(50),
  chart: v.union([PieChart, CartesianChart]),
});

const BlockSchema = v.variant("type", [
  MarkdownBlock,
  HeaderBlock,
  SectionBlock,
  ContextBlock,
  DividerBlock,
  ImageBlock,
  ActionsBlock,
  TableBlock,
  CardBlock,
  DataVisualizationBlock,
]);

export const BlocksSchema = v.pipe(v.array(BlockSchema), v.minLength(1), v.maxLength(50));

export type Block = v.InferOutput<typeof BlockSchema>;
export type Blocks = v.InferOutput<typeof BlocksSchema>;
