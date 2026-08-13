# Wishkeeper

A wishlist app with a Supabase backend: real accounts, a Postgres database, and a server-side Edge Function that pulls product details from a link — all fronted by a static site on GitHub Pages.

## What's in here

```
wishkeeper/
├── index.html
├── style.css
├── app.js
├── config.js                          ← your Supabase URL + anon key go here
├── supabase/
│   ├── schema.sql                     ← run once in the Supabase SQL editor
│   └── functions/
│       └── fetch-product/index.ts     ← deploy with the Supabase CLI
└── README.md
```

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com), create a free project.
2. In **Settings → API**, copy the **Project URL** and the **anon public** key.
3. Open `config.js` and paste them in:

```js
const SUPABASE_URL = 'https://your-project-ref.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-public-key';
```

The anon key is meant to be public — it's safe to commit and ship in frontend code. What actually protects everyone's data is Row Level Security, set up in the next step.

## 2. Set up the database

In the Supabase dashboard, go to **SQL Editor → New query**, paste in the contents of `supabase/schema.sql`, and run it. This creates:

- `lists` and `items` tables
- Row Level Security policies so each user can only ever see or modify their own rows
- A trigger that gives every new user a "My Wishlist" list automatically on signup

## 3. Enable email sign-in

Supabase has email/magic-link auth on by default. Two things worth checking in **Authentication → URL Configuration**:

- **Site URL** — set this to wherever the app will live (your GitHub Pages URL, e.g. `https://yourusername.github.io/wishkeeper/`). This is where the magic-link email sends people back to.
- **Redirect URLs** — add that same URL here too.

While testing locally, you can temporarily add `http://localhost:PORT` (whatever port you're serving from) to both.

## 4. Deploy the Edge Function

This is what fetches product pages server-side — no CORS problems, no shared public proxy. You'll need the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
npm install -g supabase
supabase login
cd wishkeeper
supabase link --project-ref your-project-ref
supabase functions deploy fetch-product
```

That's it — no extra secrets needed, the function just fetches whatever URL it's given.

## 5. Deploy the frontend to GitHub Pages

Only `index.html`, `style.css`, `app.js`, and `config.js` need to go up — the `supabase/` folder is for your own reference and CLI deploys, GitHub Pages won't serve it as anything meaningful.

1. Create a repo (e.g. `wishkeeper`) and push these files to it.
2. **Settings → Pages** → Source: "Deploy from a branch" → branch `main`, folder `/ (root)`.
3. Save. You'll get a URL like `https://yourusername.github.io/wishkeeper/`.

```bash
cd wishkeeper
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/wishkeeper.git
git push -u origin main
```

Double back to step 3 above once it's live — make sure the Supabase **Site URL** matches this exact address.

## How sync works

Each item and list lives in Postgres, scoped to your account by Row Level Security. Sign in with the same email on any device and you'll see the same wishlists. Changes also propagate live via Supabase Realtime — add an item on your phone, and it shows up on an open tab on your laptop without a refresh.

## On the "fetch details" limitation

The Edge Function fetches the page and reads its `og:title` / `og:image` / price meta tags — much more reliable than a public CORS proxy, since it's not sharing rate limits with strangers and isn't blocked by browser CORS rules at all. It will still come back empty on sites that render everything client-side in JavaScript, or that actively fingerprint and block non-browser traffic (some large retailers do this deliberately). When that happens you'll see a clear message and the manual fields — including a live image preview — are right there to fill in by hand.

## Notes

- Sign-in is passwordless (magic link) — no passwords to manage.
- `config.js` holds the anon key, which is safe to expose; nothing sensitive is client-side.
- If you ever want to nuke the database and start over, just re-run `schema.sql` after dropping the `items` and `lists` tables from the Supabase dashboard.
