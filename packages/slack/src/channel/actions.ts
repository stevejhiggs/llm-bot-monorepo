// The agent's outbound reply capability: post a Block Kit message into the bound
// Slack thread. The destination is fixed at bind time, so the model supplies only
// block content, never the channel/thread. The model's DSL is validated and
// translated by `../format/blocks.ts`; an invalid payload is reported back to the
// model (not thrown) so it can correct and retry.

import { defineTool } from "@flue/runtime";
import type { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/web-api";
import * as v from "valibot";
import { translateBlocks } from "../format/blocks.ts";
import { client } from "./client.ts";

type ThreadRef = { channelId: string; threadTs: string };

export function replyWithBlocks(ref: ThreadRef, slack: WebClient = client) {
  return defineTool({
    name: "reply_with_blocks",
    description:
      "Post a rich Block Kit message in the Slack thread bound to this conversation: markdown, " +
      "tables, cards, status, buttons, and select menus. Supply a `blocks` array (see the " +
      "slack-block-kit skill for which block to use and the limits) and an optional `text` " +
      "notification fallback. Buttons/menus you add come back to you later as a " +
      "`slack.block_action` turn, so put correlation info in each element's `value`. The target " +
      "thread is fixed; you supply only the message content.",
    input: v.object({
      blocks: v.pipe(
        v.array(v.unknown()),
        v.minLength(1),
        v.description("A Block Kit blocks array."),
      ),
      text: v.optional(
        v.pipe(v.string(), v.description("Notification/accessibility fallback text.")),
      ),
    }),
    async run({
      input: { blocks, text },
    }): Promise<{ ok: false; error: string } | { channel: string | null; ts: string | null }> {
      let translated;
      try {
        translated = translateBlocks(blocks);
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
      const result = await slack.chat.postMessage({
        channel: ref.channelId,
        thread_ts: ref.threadTs,
        text: text ?? translated.fallback,
        blocks: translated.blocks as unknown as KnownBlock[],
      });
      return { channel: result.channel ?? null, ts: result.ts ?? null };
    },
  });
}
