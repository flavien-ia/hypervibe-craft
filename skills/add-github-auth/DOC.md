# /add-github-auth

Enables **GitHub login** on your app. Your users can sign in with a one-click "Continue with GitHub".

## When to use it

- Your app targets developers or tech profiles who already have a GitHub account
- You want a one-click login in addition to email/password
- You have already run `/add-auth` in users mode

## How it works

1. **Check**: Hypervibe verifies that NextAuth in users mode is already in place. If not, it redirects you to `/add-auth`.

2. **Creating an OAuth App on GitHub**: Hypervibe guides you through GitHub's developer settings (github.com/settings/developers → OAuth Apps → New OAuth App).

3. **Filling in the form**: your app's name, production URL, callback URL. Hypervibe gives you the exact values to paste.

4. **Getting the credentials**: GitHub displays the **Client ID** directly on the page. You then click "Generate a new client secret" to get the **Client Secret** (copy it immediately, GitHub shows it only once).

5. **Automatic configuration**: Hypervibe pushes both keys into the local `.env` + Vercel, adds the GitHub provider in `src/server/auth.ts`, and updates `CLAUDE.md`.

6. **Final adjustment of the callback URL**: GitHub accepts only **one** callback URL per OAuth App. Hypervibe offers you two options to handle dev + prod: either create a 2nd OAuth App dedicated to dev (recommended), or switch the URL depending on the context.

## What it creates for you

- A GitHub **OAuth App** in your name
- The `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` variables in the local `.env` + Vercel
- The GitHub provider added to your `src/server/auth.ts`
- An update to `CLAUDE.md`

## Prerequisites

- `/add-auth` must have been run in **users mode** (admin mode is not compatible with OAuth).
- A GitHub account (free, you necessarily have one since your code is already stored there).

## Tips

{{callout:warning|One callback URL per OAuth App}}
GitHub supports only **one** callback URL per OAuth App, unlike Google which accepts several. To use GitHub OAuth locally AND in production without conflict:
- **Recommended**: create **two** separate OAuth Apps (one for `localhost:3000`, one for your prod URL). You keep the prod credentials in Vercel and the dev ones in the local `.env`.
- **Alternative**: switch the URL in the GitHub settings depending on whether you are testing locally or deploying. Simpler but less convenient.
{{/callout}}

{{callout:info|No test mode on GitHub}}
Unlike Google, GitHub OAuth has no "test mode" with a user whitelist. As soon as your OAuth App is created, **any GitHub user can log in to it**. If you want to restrict access (for example to your organisation). You will have to handle that on the code side (email whitelist, roles, etc.).
{{/callout}}
