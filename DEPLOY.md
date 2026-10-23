# Running the research study

This puts the tutor online so testers can sign up, give consent, and use it on their own iPad, tablet or laptop, with their work saved to their account. It uses two free services: **Supabase** (sign-in and the database) and **Vercel** (hosting). Plan on about 20 minutes.

## 1. Supabase: sign-in and database

1. Create a project at [supabase.com](https://supabase.com) (the free plan is fine). Pick a region near your testers and save the database password somewhere safe.
2. Create the tables. In the project, open **SQL Editor → New query**, paste the whole of `supabase/migrations/20261022000000_research_study.sql`, and press **Run**. Then do the same with `supabase/migrations/20261023000000_study_tools.sql` (quizzes, surveys, study arms, photo uploads). (If you use the Supabase CLI instead: `supabase link` then `supabase db push`.)
3. Open **Project Settings → API keys** and copy three values for step 2:
   - the **Project URL**
   - the **anon / publishable** key
   - the **service_role / secret** key. This one bypasses every privacy rule, so it only ever goes into Vercel's settings, never into the code or a chat.
4. **Authentication → Sign In / Providers → Email**: keep **Confirm email** on, so every tester proves they own their address.
5. Supabase's built-in email sender only allows a few messages an hour. Before inviting more than a handful of testers, add an email service under **Authentication → Emails → SMTP settings** (Resend, Postmark and SendGrid all have free tiers).

## 2. Vercel: hosting

1. At [vercel.com](https://vercel.com), choose **Add New → Project** and import the `study-tutor` GitHub repository. The defaults (Next.js) are right.
2. Before the first deploy, open **Environment Variables** and add:

   | Name | Value |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | your Anthropic key (the tutor runs on Claude when set) |
   | `NEXT_PUBLIC_SUPABASE_URL` | the Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon / publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role / secret key |
   | `ADMIN_EMAILS` | your email (and any co-researchers), comma-separated |
   | `STUDY_INVITE_CODE` | optional: a code testers must enter to join |
   | `DAILY_TUTOR_LIMIT` | optional: tutor turns per tester per day, default 800 (the tutor glances at the page after each pause in writing, so turns add up) |
   | `STUDY_CONDITIONS` | optional: study arms to compare, e.g. `socratic,explain`. Each tester gets one at consent, filling the smallest arm first. `socratic` is the full tutor, `on_request` only looks and speaks when asked or spoken to, `explain` gives worked solutions directly like a typical AI helper. Leave empty and everyone gets the full tutor |
   | `STUDY_PRETEST` | optional: `on` asks each tester an 8-question quiz before their first session |
   | `STUDY_POSTTEST` | optional: `on` offers the parallel end-of-study quiz in each tester's menu. Turn it on when the study period ends |
   | `OPENAI_API_KEY` | runs the tutor on GPT-6 Luna if no Anthropic key is set (`OPENAI_TUTOR_MODEL` changes the model); also the natural tutor voice |

3. Deploy. Copy the site address Vercel gives you (for example `https://study-tutor.vercel.app`).
4. Back in Supabase, open **Authentication → URL Configuration**. Set **Site URL** to that address and add `https://<your-address>/auth/callback` under **Redirect URLs**, so confirmation and password-reset links come back to the app.

## 3. Try it before inviting anyone

1. Open the site, choose **Join the study**, and sign up with the email you put in `ADMIN_EMAILS`.
2. Click the link in the confirmation email, read the consent page and start studying.
3. Write something and tap **I'm stuck** to check the tutor answers.
4. Open the participant-code button (top right) → **Researcher view** to see the study dashboard and download the CSVs.

## What testers see

- **Join the study**: email, password and the invite code if you set one, then a confirmation email.
- **Consent**: the study description, a few questions about their studies, and boxes for "I am 18 or older" and "I agree". The wording in `lib/study.ts` (`CONSENT_SECTIONS`) is a placeholder: replace it with your ethics board's approved text and change `CONSENT_VERSION`, and everyone is asked to consent again.
- **The tutor**, with their page, review cards and mastery saved to their account, so they can switch devices.
- **Quizzes** (if switched on): an 8-question calculus quiz before they start, and a parallel one at the end. The questions are in `lib/study-tests.ts`; replace them with your own validated items. Answers are scored on the server and each quiz can be taken once.
- **After a session**: when they press Finish, the recap comes with three 1-5 ratings (how much it helped, how much they figured out themselves, how natural it felt) and an optional note. They can skip it.
- **The participant-code menu**: send feedback, take the final quiz when it's open, sign out, or delete their account and all their data.

## What you get

`/admin` (only for `ADMIN_EMAILS`) shows testers, activity and feedback, with two downloads:

The dashboard also compares study arms: testers, mean pre and post quiz scores, and mean "helped" rating per arm.

- **participants.csv**: one row per tester by participant code, with intake answers, study arm, pre and post quiz scores, survey means, sessions, tutor turns, cards, reviews, feedback count, token use and last activity.
- **events.csv**: every logged event. Tutor turns include the move, what it said, the concept, slip or solved, whether it proposed a card, the review result, its private diagnosis, latency and tokens. Review grades, cards made, deck imports, photo uploads, finished sessions, surveys, quiz answers (per item, with the skill it tests) and feedback are logged too.

Neither file contains emails. The tutor's worked solution is never stored.

## Costs and limits

- Each tutor turn sends two page images to Claude. The daily cap per tester (`DAILY_TUTOR_LIMIT`) bounds your Anthropic bill; the token columns in participants.csv show actual use.
- In paper mode each turn also sends the paper's text (up to about 120k characters, roughly 30k tokens). It goes first in the request so the provider caches it: Claude via `cache_control`, OpenAI automatically. Cached input is billed at a fraction of the normal rate, but a long reading session still costs several times a homework session, so watch the token columns if testers use it a lot.
- Supabase and Vercel free tiers comfortably cover a pilot of a few dozen testers.
- Testers must be 18 or older for now. Studying with under-18s needs parental consent (and COPPA compliance for under-13s), which this version doesn't handle.
