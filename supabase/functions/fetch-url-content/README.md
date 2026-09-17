# fetch-url-content

Turns a link into Markdown. Called by `UrlImportDialog` — the two items behind
the **From a link** button on Course Materials — which stores the result as a
`.md` course material of type `other`.

Two routes behind one endpoint, and the caller names the one it wants:

| `kind` | Menu item | Provider endpoint | Result |
| --- | --- | --- | --- |
| `youtube` | From a YouTube video | `/v1/transcript`, then `/v1/metadata` | the video's transcript |
| `web` | From a web page | `/v1/web/scrape` | the page as Markdown |

`kind` is optional — omitting it falls back to inferring the route from the URL,
which is what an older caller gets — but the dialog always sends it. Sending it
is what turns a link pasted under the wrong action into "that is not a YouTube
link" instead of a scrape of a watch page that returns YouTube's own navigation
furniture. Both mismatches are refused with a 400, on the client and again here.

There is a third refusal, and it is the one worth knowing about: **a YouTube URL
naming no single video is not thereby an ordinary web page.** A playlist, a
channel, a `/results?search_query=` — none of them has a transcript, and letting
one fall through to the scraper would spend a credit to import YouTube's own
furniture as course material. `isYouTubeHost` catches those by hostname, and
they are refused under either action and under none. A look-alike domain such as
`youtube.com.attacker.example` is not a YouTube host and remains an ordinary
page.

`attribution_link` is **not** in that group, because it does name a video —
`/attribution_link?a=…&u=%2Fwatch%3Fv%3DID` — and `parseYouTubeVideoId` unwraps
`u` to find it. The unwrap resolves `u` against YouTube's own origin, so a `u`
naming another host stays on that host and fails the allow-list instead of
borrowing YouTube's; a wrapper nested in a wrapper is refused rather than
followed, being a redirect chain rather than a URL to parse.

Read-only. Gated on managing the `courseId` in the body (see `AUTHORIZATION.md`).
The course's `language` is passed to the provider on both routes, so a page or a
transcript available in several languages comes back in the one the class is
taught in.

## Every fetch goes to the provider

Neither route reaches the site itself. The function talks to Supadata and to the
Supabase API, and to nothing else — `fetch-url-content.handler.test.ts` asserts
that as a hostname allow-list rather than a list of hosts to avoid, so a route
added later cannot quietly reintroduce a direct fetch.

Two things went when the direct routes did:

- **The SSRF sink.** Fetching a caller-supplied URL from inside our own
  infrastructure is a liability that needed a blocklist, manual redirect
  following and a re-check at every hop to contain. Supadata resolving
  `http://localhost` resolves its own. `assertPublicHttpUrl` is still there and
  still refuses private, loopback, link-local and CGNAT addresses, but its job
  is now naming a mistaken link before a credit is spent on it.
- **The no-key fallback.** A page used to be importable with no API key at all,
  via a small regex HTML→Markdown converter. It was always the worse extraction,
  and it is now gone: **the provider key is required for both routes.** Without
  it the function answers `503` naming `CONTENT_PROVIDER_API_KEY`.

## Why Markdown and not a PDF

An earlier cut rendered the text to a PDF via ConvertAPI, on the assumption that
an "Other" material has to be a PDF to be attachable as an OpenAI `input_file`.
It does not: OpenAI's documented `input_file` types include `.md` and `.txt`,
and vector stores index them too. Storing text as text keeps it searchable and
correctable, drops a third-party dependency from the path, and skips a
conversion that could only lose information.

`CoursePage` renders a `.md` material with `MarkdownContent` instead of the PDF
viewer, and hides the thumbnail affordance for it — there is no page to
rasterise.

## Why the YouTube route cannot fetch from YouTube

Not only policy — it does not work. YouTube gates caption downloads behind a
BotGuard proof-of-origin token. Measured from a server on 2026-08-31, against a
public video with manually uploaded captions:

| Route | Result |
| --- | --- |
| `youtubei/v1/player`, clients WEB / MWEB / ANDROID / IOS / ANDROID_VR / TVHTML5 / WEB_CREATOR | `LOGIN_REQUIRED`, `UNPLAYABLE` or HTTP 400 — no caption tracks |
| Watch-page scrape of `ytInitialPlayerResponse` | tracks ARE listed |
| `api/timedtext` from those tracks (`json3`, `srv3`, XML, with page cookies, with `Referer`) | **HTTP 200, empty body** |
| `youtubei/v1/get_transcript`, including with the exact `params` copied out of the page and the page's `visitorData` | HTTP 400 `FAILED_PRECONDITION` |

Every one of those routes lived in `_shared/youtube.ts` at some point, tried
before the provider on the theory that a free route beats a paid one. None of
them ever produced a transcript in production. They are gone.

## What the metadata call is for

A video's title, channel and duration used to come free from the player response
the transcript route already had to parse. `/v1/transcript` returns `content`,
`lang` and `availableLangs` — no title — so those three fields now cost a second
call, to `/v1/metadata`.

It is made **after** the transcript and only when there is one, so a video with
nothing to import costs one credit rather than two. It is also best-effort: a
metadata call that fails is logged and the import proceeds without a title,
because a transcript with no title is a worse import, not a failed one. The
dialog falls back to the video id for the filename and lets the instructor type
a title.

One field did not survive: whether the captions are auto-generated. It came from
`track.kind === "asr"` in the player response, Supadata reports no equivalent,
and a flag that is always false is worse than no flag — so the "Auto-generated
captions" badge and the provenance line are gone rather than permanently silent.

## Refusing a link before it costs anything

`assertPublicHttpUrl` refuses non-`http(s)` schemes, embedded credentials,
`localhost`, `*.local` / `*.internal`, every private, loopback, link-local
(including `169.254.169.254`) and CGNAT range, and their IPv6 equivalents. The
provider does the fetching now, so this is no longer the SSRF containment it was
written as — it is a cheap refusal of a link that cannot be a public page, made
here rather than paid for at the provider.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `CONTENT_PROVIDER_API_KEY` (or the older `YOUTUBE_TRANSCRIPT_API_KEY`) | **yes, for both routes** | Provider API key. Unset means no imports at all: the function answers 503. |
| `CONTENT_TRANSCRIPT_API_URL` (or `YOUTUBE_TRANSCRIPT_API_URL`) | no | Transcript endpoint. Default `https://api.supadata.ai/v1/transcript`. |
| `CONTENT_METADATA_API_URL` | no | Video metadata endpoint. Default `https://api.supadata.ai/v1/metadata`. |
| `CONTENT_SCRAPE_API_URL` | no | Scrape endpoint. Default `https://api.supadata.ai/v1/web/scrape`. |
| `CONTENT_PROVIDER_POLL_BUDGET_MS` | no | How long to wait out an async job before telling the instructor to retry. Default 60000. |

Note `/v1/transcript`, not `/v1/youtube/transcript`: the YouTube-specific
endpoint is marked deprecated in Supadata's own OpenAPI spec, and its
documentation does not cover the `202 {jobId}` async flow that most course
videos take.

The key is sent as `x-api-key` and **nothing else**. It used to be sent as both
that and `Authorization: Bearer`, so that pointing the code at another provider
would be a config change; that broke every import in production with a valid
key, because Supadata rejects any request carrying an `Authorization` header.
Measured against `api.supadata.ai` on 2026-09-02, on the transcript and scrape
endpoints alike:

| Headers | Result |
| --- | --- |
| `x-api-key` alone | **200** |
| `x-api-key` + `Authorization: Bearer` | **401 Unauthorized** |
| `Authorization: Bearer` alone | **401 Unauthorized** |

Do not add it back on the theory that an extra header is harmless. A provider
that wants a bearer token is a one-line change in `providerRequest`, made when
there is such a provider; `fetch-url-content.handler.test.ts` asserts the
absence of the header so the outage cannot recur silently.

The response parser is still deliberately tolerant — content is accepted under
`content`, `markdown`, `transcript`, `text`, `segments`, `captions` or `data`,
as a string or as an array of cue objects — so the response *shape* remains a
config concern rather than a code one.

### Getting a key (Supadata)

1. Sign up at <https://supadata.ai> — free tier, no card, 100 credits/month at
   the time of writing.
2. Copy the key from the dashboard.
3. Set it as below.

Worth verifying independently of the app before blaming the import:

```sh
curl 'https://api.supadata.ai/v1/transcript?url=https://youtu.be/dQw4w9WgXcQ&text=true' \
  -H "x-api-key: $CONTENT_PROVIDER_API_KEY"
curl 'https://api.supadata.ai/v1/web/scrape?url=https://example.com' \
  -H "x-api-key: $CONTENT_PROVIDER_API_KEY"
curl 'https://api.supadata.ai/v1/metadata?url=https://youtu.be/dQw4w9WgXcQ' \
  -H "x-api-key: $CONTENT_PROVIDER_API_KEY"
```

### The async job flow

**Anything over 20 minutes is queued**: the provider answers
`202 {"jobId": …}`, and the content is collected from `…/{jobId}`, which reports
`queued` / `active` / `completed` / `failed`. Most course videos are longer than
20 minutes, so that is the ordinary path here rather than an edge case — an
earlier cut treated the 202 as "no transcript" and would have failed on exactly
the videos the feature exists for.

The wait is bounded (`CONTENT_PROVIDER_POLL_BUDGET_MS`, default 60s, polled
every 2s) because the edge invocation has a wall clock of its own. Exhausting it
is reported as "still working, try again" rather than as a failure: the provider
keeps a finished result for an hour, so a retry collects it.

### Setting it

Production (and any other hosted project):

```sh
supabase secrets set CONTENT_PROVIDER_API_KEY=sk-...
```

Branch databases are separate projects and do not inherit the parent's secrets.
A deployment that wants this key on preview branches supplies its own
`supabase/.env.preview` — that file is deployment-specific and is not committed
here (see `.gitignore`), so it lives in whatever private repository does the
hosting:

```sh
npx @dotenvx/dotenvx set CONTENT_PROVIDER_API_KEY 'sk-...' -f supabase/.env.preview --encrypt
```

and add the declaration to `config.toml` under `[edge_runtime.secrets]`:

```toml
CONTENT_PROVIDER_API_KEY = "env(CONTENT_PROVIDER_API_KEY)"
```

The declaration is deliberately left out here. `config.toml` syncs to every
branch, so adding the entry before a deployment has the corresponding value
fails config parsing and blocks branch provisioning outright — the whole branch,
not just this function.
