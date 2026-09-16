# Escape from Slop Prison: interactive AI film

A live, choose-your-own-escape anime film. Tell Sloppy Joe what to do; an LLM judges the idea, writes the next shot, and MiniMax H3 generates it in seconds.

Built at the Multimodal Society AI Filmmaking Hackathon with MachGen (MiniMax H3, Nano Banana Pro, ElevenLabs Music), GMI Cloud (Gemini), and HyperFrames.

- **[Testing yourself](<testing yourself.md>)**: `keys.json` setup, how to start, admin settings, costs, debug history
- **[Deploying](<testing yourself.md#9-deploying-railway-docker>)**: Docker + Railway (volume at `/data`, keys as env vars)
- **[Master plan](master-plan.md)**: design, pipeline, style bible, world catalog, and TODOs

```bash
bun install
```

```bash
bun run dev
```

## Where generated media lives

Generated clips, stitched exports and share thumbnails go to **Cloudflare R2**; the committed assets
(`media/intro`, the soundtrack, the reference stills) stay in the image and are always served from disk.

The container used to keep every generated clip forever — the action archive pruned its database rows but
never the files — which filled the deploy volume and broke generation. Now the only things on the volume are
the debug SQLite database and `settings.json`, and ffmpeg's working files, which are deleted with the scratch
directory each render uses.

Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` (see `.env.example`). Leave
them unset locally and everything falls back to disk, so `bun run dev` needs no Cloudflare account.

Nothing in the bucket is public. The browser keeps requesting the same stable `/media/...` URLs it always
did, and the server redirects each one to a short-lived signed URL, so **a shared link never expires** even
though the signature behind it does. Credentials stay server-side and are never handed to the client.

Already have files on a deploy volume? Move them across without changing any link:

```bash
railway run bun scripts/migrate-storage-to-r2.ts --apply
```
