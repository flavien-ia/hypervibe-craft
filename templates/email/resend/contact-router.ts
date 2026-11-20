import { z } from "zod";
import { createTRPCRouter, rateLimitedProcedure } from "~/server/api/trpc";
import { sendMail, escapeHtml } from "~/server/mail";

export const contactRouter = createTRPCRouter({
  send: rateLimitedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        email: z.string().email(),
        message: z.string().min(1).max(5000),
        website: z.string().max(200).optional(), // honeypot field
      }),
    )
    .mutation(async ({ input }) => {
      // Honeypot: if the hidden field is filled, it's a bot - reject silently
      if (input.website && input.website.length > 0) {
        return { success: true }; // Fake success to not alert the bot
      }

      const safeName = escapeHtml(input.name);
      const safeEmail = escapeHtml(input.email);
      const safeMessage = escapeHtml(input.message);

      await sendMail({
        to: process.env.CONTACT_RECIPIENT_EMAIL ?? process.env.RESEND_FROM_EMAIL!,
        subject: `Contact form: ${input.name}`,
        html: `<p><strong>From:</strong> ${safeName} (${safeEmail})</p><p>${safeMessage}</p>`,
        text: `From: ${input.name} (${input.email})\n\n${input.message}`,
        // A visitor's own words, and no link of the site's: never refused for an address they quote.
        allowLocalLinks: true,
      });
      return { success: true };
    }),
});
