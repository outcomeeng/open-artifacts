// #2224: through the real /mcp transport with bus link proofs, answer.yes is
// true only for the agent that posted the ask, not for another linked agent
// of the same member or an unlinked one.
import { BUS_CAPS, LINK_PROOF_HEADER } from "@oa/bus-protocol";
import {
  type ArtifactAgent,
  type CommentList,
  type CompactCommentList,
  type Member,
  R,
} from "@oa/shared";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import { publish } from "../../src/services/artifacts.js";
import { getUser } from "../../src/services/users.js";
import { sha256Hex } from "../../src/util/crypto.js";
import { api } from "../helpers.js";
import { close, connect, E, tool } from "../mcp-helpers.js";
import {
  daemon,
  e,
  hello,
  machine,
  member,
  ns,
  up,
  waitFor,
} from "./helpers.js";

const app = createApp();
const proofOf = () =>
  `${"p".repeat(11)}${crypto.randomUUID().replaceAll("-", "")}`;

describe("answer.yes over MCP (#2224)", () => {
  const clients: Awaited<ReturnType<typeof connect>>[] = [];
  afterAll(() => Promise.all(clients.map((c) => close(c))));

  it("true for the asking agent, false for another linked agent of the member and an unlinked one", async () => {
    const m = await member();
    const user = (await getUser(e, m.userId)) as Member;
    const mach = await machine("Laptop", m.userId);
    const d = await daemon(mach.token);
    d.send({ ...hello("h1"), caps: [BUS_CAPS.link] } as never);
    await waitFor(d, "hello_ok");
    const space = ns("yes");
    const proofs = [proofOf(), proofOf()];
    for (const [i, proof] of proofs.entries()) {
      d.send(up(`u${i}`, `ref${i}`, `Agent${i}`, space));
      await waitFor(d, "agent_ok");
      d.send({
        v: 1,
        id: `b${i}`,
        type: "link_bind",
        agent_ref: `ref${i}`,
        hash: await sha256Hex(proof),
      } as never);
      await waitFor(d, "link_bound");
    }
    const { token } = await createPat(e, m.userId, "yes");
    const asker = await connect(token, {
      headers: { [LINK_PROOF_HEADER]: proofs[0] as string },
    });
    const other = await connect(token, {
      headers: { [LINK_PROOF_HEADER]: proofs[1] as string },
    });
    const unlinked = await connect(token);
    clients.push(asker, other, unlinked);

    const id = (
      await publish(
        E(),
        user,
        {
          title: "doc",
          format: "html",
          content: "<p>The quick brown fox</p>",
          comments: "everyone",
        } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    const made = await tool(asker, "add_comment", {
      id,
      body: "Which layout?",
      ask: {
        question: "Which layout do we ship?",
        options: [
          { id: "wide", label: "Wide" },
          { id: "compact", label: "Compact" },
        ],
        to: [{ key: m.userId }],
      },
    });
    expect(made.isError, JSON.stringify(made.content)).toBeFalsy();
    const { threadId, commentId } = made.structuredContent as {
      threadId: string;
      commentId: string;
    };
    // The person answers in the web app.
    const res = await api(
      app,
      R.commentAnswer(id, threadId, commentId),
      m.cookie,
      {
        method: "POST",
        body: { optionId: "wide" },
      },
    );
    expect(res.status).toBe(200);

    const yes = async (c: typeof asker) => {
      const r = await tool(c, "list_comments", { id });
      expect(r.isError).toBeFalsy();
      const list = r.structuredContent as CommentList;
      const ans = list.threads[0]?.comments[0]?.ask?.answer;
      expect(ans?.optionId).toBe("wide");
      return ans?.yes;
    };
    expect(await yes(asker)).toBe(true);
    expect(await yes(other)).toBe(false);
    expect(await yes(unlinked)).toBe(false);
  });

  it("with ask.for and subject: true for the named agent, false for the asker, another linked agent and an unlinked one", async () => {
    const m = await member();
    const user = (await getUser(e, m.userId)) as Member;
    const mach = await machine("Laptop", m.userId);
    const d = await daemon(mach.token);
    d.send({ ...hello("h2"), caps: [BUS_CAPS.link] } as never);
    await waitFor(d, "hello_ok");
    const space = ns("for-yes");
    const proofs = [proofOf(), proofOf(), proofOf()];
    const names = ["AgentA", "AgentB", "AgentC"] as const;
    for (const [i, proof] of proofs.entries()) {
      d.send(up(`uf${i}`, `reff${i}`, names[i] as string, space));
      await waitFor(d, "agent_ok");
      d.send({
        v: 1,
        id: `bf${i}`,
        type: "link_bind",
        agent_ref: `reff${i}`,
        hash: await sha256Hex(proof),
      } as never);
      await waitFor(d, "link_bound");
    }
    const { token } = await createPat(e, m.userId, "for-yes");
    const agentA = await connect(token, {
      headers: { [LINK_PROOF_HEADER]: proofs[0] as string },
    });
    const agentB = await connect(token, {
      headers: { [LINK_PROOF_HEADER]: proofs[1] as string },
    });
    const agentC = await connect(token, {
      headers: { [LINK_PROOF_HEADER]: proofs[2] as string },
    });
    const unlinked = await connect(token);
    clients.push(agentA, agentB, agentC, unlinked);

    const id = (
      await publish(
        E(),
        user,
        {
          title: "doc",
          format: "html",
          content: "<p>Delegated approval check</p>",
          comments: "everyone",
        } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    const roster = (await (
      await api(app, R.artifactAgents(id), m.cookie)
    ).json()) as ArtifactAgent[];
    const keyB = roster.find((a) => a.name === "AgentB")?.key;
    expect(keyB).toBeDefined();

    const beforeAnswer = new Date(Date.now() - 1000).toISOString();
    const subject = "outcomeeng/open-artifacts@42f8c7b";
    const made = await tool(agentA, "add_comment", {
      id,
      body: "Ready to merge?",
      ask: {
        question: "Merge PR #2?",
        options: [
          { id: "merge", label: "Merge now" },
          { id: "hold", label: "Hold" },
        ],
        to: [{ key: m.userId }],
        for: [{ key: keyB as string }],
        subject,
      },
    });
    expect(made.isError, JSON.stringify(made.content)).toBeFalsy();
    const { threadId, commentId } = made.structuredContent as {
      threadId: string;
      commentId: string;
    };

    const res = await api(
      app,
      R.commentAnswer(id, threadId, commentId),
      m.cookie,
      {
        method: "POST",
        body: { optionId: "merge" },
      },
    );
    expect(res.status).toBe(200);

    const readAsk = async (c: typeof agentA) => {
      const r = await tool(c, "list_comments", { id });
      expect(r.isError).toBeFalsy();
      const list = r.structuredContent as CommentList;
      return list.threads[0]?.comments[0]?.ask;
    };
    const seenByB = await readAsk(agentB);
    expect(seenByB?.subject).toBe(subject);
    expect(seenByB?.for?.map((p) => p.name)).toEqual(["AgentB"]);
    expect(seenByB?.answer?.optionId).toBe("merge");
    expect(seenByB?.answer?.yes).toBe(true);

    const seenByA = await readAsk(agentA);
    expect(seenByA?.answer?.optionId).toBe("merge");
    expect(seenByA?.answer?.yes).toBe(false);

    expect((await readAsk(agentC))?.answer?.yes).toBe(false);
    expect((await readAsk(unlinked))?.answer?.yes).toBe(false);

    // Compact catch-up lists the answered ask for B with yes: true, for A with yes: false, and omits it for C.
    const catchUp = async (c: typeof agentA) => {
      const r = await tool(c, "list_comments", {
        id,
        answeredSince: beforeAnswer,
        compact: true,
      });
      expect(r.isError).toBeFalsy();
      return (r.structuredContent as CompactCommentList).answers ?? [];
    };
    expect(await catchUp(agentB)).toMatchObject([
      { threadId, commentId, optionId: "merge", yes: true },
    ]);
    expect(await catchUp(agentA)).toMatchObject([
      { threadId, commentId, optionId: "merge", yes: false },
    ]);
    expect(await catchUp(agentC)).toEqual([]);
  });
});
