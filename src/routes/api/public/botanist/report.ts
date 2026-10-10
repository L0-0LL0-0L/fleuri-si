import { createFileRoute } from "@tanstack/react-router";

// x402 V2 resource. Public by design: the 402 quote is free; payment is verified locally,
// settled by the facilitator and confirmed on chain before the report is returned.
// Retrieval of an existing job requires its high-entropy capability token.
export const Route = createFileRoute("/api/public/botanist/report")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleBotanist } = await import("@/lib/botanist.server");
        try { return await handleBotanist(request); }
        catch (e) { console.error("[botanist]", e); return Response.json({ error: "Botanist is temporarily unavailable." }, { status: 500 }); }
      },
    },
  },
});
