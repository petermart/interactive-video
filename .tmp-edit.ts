const rep = async (p: string, a: string, b: string) => { const s = await Bun.file(p).text(); if (!s.includes(a)) throw new Error(`${p}: ${a.slice(0,60)}`); await Bun.write(p, s.replace(a, b)); };
await rep("src/server/machgen.ts", `/** Extracts the last frame of a video as a PNG (ffmpeg). */`, `const uploadedAssets = new Map<string, Promise<string>>();

/**
 * Uploads a repo asset image once per server run (downscaled to a 1600px JPEG) and caches its @input ref.
 * Asset PNGs are ~5MB at 3641x2048; references don't need that resolution.
 */
export function uploadAsset(repoPath: string) {
  let ref = uploadedAssets.get(repoPath);
  if (!ref) {
    ref = (async () => {
      const jpeg = \`\${CACHE_DIR}/refs/\${repoPath.replace(/[\\/]/g, "__").replace(/\.png$/i, ".jpg")}\`;
      mkdirSync(\`\${CACHE_DIR}/refs\`, { recursive: true });
      if (!existsSync(jpeg)) {
        const proc = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-i", \`\${ROOT}\${repoPath}\`, "-vf", "scale=1600:-2", "-q:v", "3", jpeg]);
        if ((await proc.exited) !== 0) throw new Error(\`ffmpeg failed downscaling \${repoPath}\`);
      }
      return uploadFile(jpeg);
    })();
    ref.catch(() => uploadedAssets.delete(repoPath));
    uploadedAssets.set(repoPath, ref);
  }
  return ref;
}

/** Extracts the last frame of a video as a PNG (ffmpeg). */`);
await rep("src/server/machgen.ts", `import { CACHE_DIR, keys } from "./config";`, `import { existsSync, mkdirSync } from "node:fs";
import { CACHE_DIR, keys, ROOT } from "./config";`);

await rep("src/server/pipeline.ts", `import { generateVideo, lastFrame, MAX_IMAGE_REFS, uploadFile, type VideoRequest } from "./machgen";`,
  `import { existsSync } from "node:fs";
import { generateVideo, lastFrame, MAX_IMAGE_REFS, uploadAsset, uploadFile, type VideoRequest } from "./machgen";`);
await rep("src/server/pipeline.ts", `async function buildClipRequest(plan: ShotPlan, from: StoryNode): Promise<VideoRequest> {
  const previousFrame = from.lastFrameFile ? await uploadFile(from.lastFrameFile) : null;
  const { refs, cast } = selectReferences(plan, Boolean(previousFrame));
  const durationSecs = STEP_SECS;

  if (refs.length + cast.length > 0) {
    // TODO: asset images must be public URLs or uploaded @input refs once they exist.
    const all = [...refs, ...(previousFrame ? [{ label: "the previous shot's final frame (continuity)", image: previousFrame }] : []), ...cast];
    const legend = all.map((r, i) => \`Image \${i + 1}: \${r.label}.\`).join(" ");
    return {
      task_type: "R2V",
      prompt: \`\${legend}\n\n\${plan.shotPrompt}\`,
      src_image_urls: all.map(r => r.image).slice(0, MAX_IMAGE_REFS),
      durationSecs,
    };
  }`, `/** The intro starts and ends on this keyframe, so it stands in for the intro's last frame. */
const INTRO_LAST_FRAME = "common-generated-assets/videos/intro-keyframe.png";

export async function buildClipRequest(plan: ShotPlan, from: StoryNode): Promise<VideoRequest> {
  const previousFrame = from.lastFrameFile
    ? await uploadFile(from.lastFrameFile)
    : from.parentId === null && existsSync(INTRO_LAST_FRAME)
      ? await uploadAsset(INTRO_LAST_FRAME)
      : null;
  const { refs, cast } = selectReferences(plan, Boolean(previousFrame));
  const durationSecs = STEP_SECS;

  if (refs.length + cast.length > 0) {
    // Order: environment, protagonist, previous frame, then ranked cast (max 9).
    const labeled = [...refs, ...cast.slice(0, 0)];
    const all = [
      ...labeled,
      ...(previousFrame ? [{ label: "the previous shot's final frame (continuity)", ref: previousFrame }] : []),
      ...cast,
    ].slice(0, MAX_IMAGE_REFS);
    const urls = await Promise.all(all.map(r => ("ref" in r ? r.ref : uploadAsset(r.image))));
    const legend = all.map((r, i) => \`Image \${i + 1}: \${r.label}.\`).join(" ");
    return {
      task_type: "R2V",
      prompt: \`\${legend}\n\n\${plan.shotPrompt}\`,
      src_image_urls: urls,
      durationSecs,
    };
  }`);
console.log("ok");
