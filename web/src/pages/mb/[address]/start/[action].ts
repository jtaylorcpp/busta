/**
 * POST /mb/<address>/start/<action> — Getting started progress:
 *   skip-rule  step 1 skipped: no folder, go on to the test
 *   skip-test  step 2 skipped: go to "see where it went"
 *   finish     guide done: Messages shows the one-time "You're set up" bar
 *   hide       close the guide (or that bar)
 *   reopen     start again from the account menu, keeping its folder
 */
import type { APIRoute } from "astro";
import { gate } from "../../../../lib/actions";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const b = `/mb/${encodeURIComponent(g.address)}`;
  switch (ctx.params.action) {
    case "skip-rule": {
      const guide = await g.stub.guide();
      await g.stub.updateGuide({ ruleSkipped: true, testSince: guide.testSince ?? Date.now() });
      return ctx.redirect(`${b}/start/test`, 303);
    }
    case "skip-test":
      await g.stub.updateGuide({ testSkipped: true });
      return ctx.redirect(b, 303);
    case "finish":
      await g.stub.updateGuide({ status: "done" });
      return ctx.redirect(b, 303);
    case "hide":
      await g.stub.updateGuide({ status: "hidden" });
      return ctx.redirect(b, 303);
    case "reopen":
      await g.stub.restartGuide();
      return ctx.redirect(b, 303);
    default:
      return new Response("Not found", { status: 404 });
  }
};
