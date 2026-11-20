import { z } from "zod";
import { createTRPCRouter, rateLimitedProcedure } from "~/server/api/trpc";
import { sendMail, escapeForBrevo } from "~/server/mail";

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

      const safeName = escapeForBrevo(input.name);
      const safeEmail = escapeForBrevo(input.email);
      const safeMessage = escapeForBrevo(input.message);

      await sendMail({
        to: [
          {
            email:
              process.env.CONTACT_RECIPIENT_EMAIL ??
              process.env.BREVO_SENDER_EMAIL!,
          },
        ],
        subject: `Contact form: ${input.name.replace(/\{\{/g, "{ {")}`,
        htmlContent: `<p><strong>From:</strong> ${safeName} (${safeEmail})</p><p>${safeMessage}</p>`,
        textContent: `From: ${input.name} (${input.email})\n\n${input.message}`.replace(
          /\{\{/g,
          "{ {",
        ),
        // A visitor's own words, and no link of the site's: never refused for an address they quote.
        allowLocalLinks: true,
      });
      return { success: true };
    }),
});
